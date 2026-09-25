#!/usr/bin/env bash
# Archive, verify, and export/upload a single Cubby Apple app platform.
# GitHub Actions owns runner credentials and per-platform job topology
# (parallel per-platform archives, one shared upload job); this script owns
# the Xcode contract for each subcommand. See
# .github/workflows/apple-testflight.yaml for how `archive` and `export`
# compose into a release: the `archive` job runs `archive <ios|macos>` for
# each platform in parallel, then the `upload` job runs `export ios` and
# `export macos` after downloading both archives, so neither platform
# uploads unless both archived successfully.
set -euo pipefail

usage() {
  echo "usage: $0 archive <ios|macos>" >&2
  echo "       $0 export <ios|macos>" >&2
  echo "common env: MARKETING_VERSION TESTFLIGHT_OUTPUT_DIR" >&2
  echo "archive additionally needs: <PLATFORM>_BUILD_NUMBER <PLATFORM>_PROFILES_JSON" >&2
  echo "export additionally needs: <PLATFORM>_PROFILES_JSON ASC_API_KEY_PATH APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID" >&2
  echo "  (macOS also needs MAC_INSTALLER_SIGNING_CERTIFICATE)" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi
command="$1"
platform="$2"
case "$command" in
  archive | export) ;;
  *)
    usage
    exit 2
    ;;
esac
case "$platform" in
  ios | macos) ;;
  *)
    usage
    exit 2
    ;;
esac

require() {
  local variable
  for variable in "$@"; do
    [[ -n "${!variable:-}" ]] || {
      echo "error: required environment variable $variable is empty" >&2
      exit 1
    }
  done
}

require MARKETING_VERSION TESTFLIGHT_OUTPUT_DIR

readonly team_id="Y9A97FXT63"
readonly bundle_id="com.nickysemenza.cubby"
readonly project="apps/apple/Cubby.xcodeproj"
readonly derived_data="$TESTFLIGHT_OUTPUT_DIR/DerivedData"
readonly ios_archive="$TESTFLIGHT_OUTPUT_DIR/Cubby-iOS.xcarchive"
readonly macos_archive="$TESTFLIGHT_OUTPUT_DIR/Cubby-macOS.xcarchive"
mkdir -p "$TESTFLIGHT_OUTPUT_DIR"

resolve_profile() {
  local profiles="$1"
  local expected_name="$2"
  local expected_type="$3"
  local extension="$4"
  local matches uuid path decoded identifier_key profile_app_identifier associated_domains

  matches="$(jq --arg name "$expected_name" --arg type "$expected_type" \
    '[.[] | select(.name == $name and .type == $type)] | length' <<< "$profiles")"
  [[ "$matches" == "1" ]] || {
    echo "error: expected exactly one active $expected_type profile named '$expected_name'; found $matches" >&2
    exit 1
  }

  uuid="$(jq -r --arg name "$expected_name" --arg type "$expected_type" \
    '.[] | select(.name == $name and .type == $type) | .udid' <<< "$profiles")"
  path="$HOME/Library/MobileDevice/Provisioning Profiles/${uuid}.${extension}"
  [[ -f "$path" ]] || {
    echo "error: downloaded profile was not installed at $path" >&2
    exit 1
  }

  decoded="$TESTFLIGHT_OUTPUT_DIR/${expected_type}.plist"
  security cms -D -i "$path" > "$decoded"
  [[ "$(plutil -extract Name raw -o - "$decoded")" == "$expected_name" ]]
  [[ "$(plutil -extract TeamIdentifier.0 raw -o - "$decoded")" == "$team_id" ]]
  identifier_key="application-identifier"
  [[ "$expected_type" == "MAC_APP_STORE" ]] && identifier_key="com.apple.application-identifier"
  profile_app_identifier="$(
    /usr/libexec/PlistBuddy -c "Print :Entitlements:$identifier_key" "$decoded"
  )"
  [[ "$profile_app_identifier" == "$team_id.$bundle_id" ]]
  # App Store profiles authorize the capability with `*`; the signed app's
  # entitlements retain the exact applinks domain from the target.
  associated_domains="$(
    /usr/libexec/PlistBuddy \
      -c 'Print :Entitlements:com.apple.developer.associated-domains' "$decoded"
  )"
  grep -Eq '^\*$|applinks:cubby\.nickysemenza\.com' <<< "$associated_domains"

  printf '%s' "$uuid"
}

write_export_options() {
  local path="$1"
  local profile_uuid="$2"
  local destination="upload"
  local installer_certificate="${3:-}"

  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0"><dict/></plist>' > "$path"
  /usr/libexec/PlistBuddy -c "Add :destination string $destination" "$path"
  /usr/libexec/PlistBuddy -c 'Add :manageAppVersionAndBuildNumber bool false' "$path"
  /usr/libexec/PlistBuddy -c 'Add :method string app-store-connect' "$path"
  /usr/libexec/PlistBuddy -c 'Add :provisioningProfiles dict' "$path"
  /usr/libexec/PlistBuddy -c "Add :provisioningProfiles:$bundle_id string $profile_uuid" "$path"
  /usr/libexec/PlistBuddy -c 'Add :signingCertificate string Apple Distribution' "$path"
  /usr/libexec/PlistBuddy -c 'Add :signingStyle string manual' "$path"
  /usr/libexec/PlistBuddy -c "Add :teamID string $team_id" "$path"
  /usr/libexec/PlistBuddy -c 'Add :testFlightInternalTestingOnly bool true' "$path"
  /usr/libexec/PlistBuddy -c 'Add :uploadSymbols bool true' "$path"
  if [[ -n "$installer_certificate" ]]; then
    /usr/libexec/PlistBuddy -c "Add :installerSigningCertificate string $installer_certificate" "$path"
  fi
  plutil -lint "$path"
}

archive_platform() {
  local scheme="$1"
  local destination="$2"
  local archive="$3"
  local profile_uuid="$4"
  local build_number="$5"
  shift 5

  xcodebuild archive \
    -project "$project" \
    -scheme "$scheme" \
    -configuration Release \
    -destination "$destination" \
    -archivePath "$archive" \
    -derivedDataPath "$derived_data" \
    -skipPackagePluginValidation \
    CUBBY_PROVISIONING_PROFILE_SPECIFIER="$profile_uuid" \
    MARKETING_VERSION="$MARKETING_VERSION" \
    CURRENT_PROJECT_VERSION="$build_number" \
    COMPILER_INDEX_STORE_ENABLE=NO \
    "$@"
}

verify_archive() {
  local archive="$1"
  local app="$2"
  local info="$3"
  local privacy_manifest="$4"
  local embedded_profile="$5"
  local build_number="$6"
  local check_macos_category="${7:-false}"

  [[ -d "$app" ]]
  [[ "$(plutil -extract CFBundleShortVersionString raw -o - "$info")" == "$MARKETING_VERSION" ]]
  [[ "$(plutil -extract CFBundleVersion raw -o - "$info")" == "$build_number" ]]
  [[ -f "$privacy_manifest" && -f "$embedded_profile" ]]
  codesign --verify --deep --strict --verbose=2 "$app"
  find "$archive/dSYMs" -name '*.dSYM' -print -quit | grep -q .
  xcrun dwarfdump --uuid "$archive/dSYMs/Cubby.app.dSYM"

  if [[ "$check_macos_category" == "true" ]]; then
    # v1.0.3 shipped a macOS archive with no App Store category: Apple
    # rejects a macOS submission whose Info.plist is missing
    # LSApplicationCategoryType, but xcodebuild only surfaces that at
    # export/upload time. Catch it here instead, right after archiving.
    local category
    category="$(plutil -extract LSApplicationCategoryType raw -o - "$info" 2>/dev/null || true)"
    [[ -n "$category" ]] || {
      echo "error: $info is missing LSApplicationCategoryType" >&2
      exit 1
    }
  fi
}

export_platform() {
  local archive="$1"
  local output="$2"
  local options="$3"
  local arguments=(
    -exportArchive
    -archivePath "$archive"
    -exportPath "$output"
    -exportOptionsPlist "$options"
  )
  arguments+=(
    -authenticationKeyPath "$ASC_API_KEY_PATH"
    -authenticationKeyID "$APP_STORE_CONNECT_KEY_ID"
    -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID"
  )
  xcodebuild "${arguments[@]}"
}

if [[ "$command" == "archive" ]]; then
  build_number_var="$(tr '[:lower:]' '[:upper:]' <<< "$platform")_BUILD_NUMBER"
  profiles_var="$(tr '[:lower:]' '[:upper:]' <<< "$platform")_PROFILES_JSON"
  require "$build_number_var" "$profiles_var"
  build_number="${!build_number_var}"
  profiles_json="${!profiles_var}"

  case "$platform" in
    ios)
      profile_uuid="$(resolve_profile "$profiles_json" "AppStore com.nickysemenza.cubby iOS" IOS_APP_STORE mobileprovision)"
      archive_platform Cubby-iOS 'generic/platform=iOS' "$ios_archive" "$profile_uuid" "$build_number"
      verify_archive \
        "$ios_archive" \
        "$ios_archive/Products/Applications/Cubby.app" \
        "$ios_archive/Products/Applications/Cubby.app/Info.plist" \
        "$ios_archive/Products/Applications/Cubby.app/PrivacyInfo.xcprivacy" \
        "$ios_archive/Products/Applications/Cubby.app/embedded.mobileprovision" \
        "$build_number"
      ;;
    macos)
      profile_uuid="$(resolve_profile "$profiles_json" "AppStore com.nickysemenza.cubby macOS" MAC_APP_STORE provisionprofile)"
      archive_platform Cubby-macOS 'generic/platform=macOS' "$macos_archive" "$profile_uuid" "$build_number" ARCHS=arm64
      verify_archive \
        "$macos_archive" \
        "$macos_archive/Products/Applications/Cubby.app" \
        "$macos_archive/Products/Applications/Cubby.app/Contents/Info.plist" \
        "$macos_archive/Products/Applications/Cubby.app/Contents/Resources/PrivacyInfo.xcprivacy" \
        "$macos_archive/Products/Applications/Cubby.app/Contents/embedded.provisionprofile" \
        "$build_number" \
        true
      ;;
  esac

elif [[ "$command" == "export" ]]; then
  # Unlike `archive`, `export` never reads a build number: xcodebuild
  # -exportArchive takes it from the already-archived .xcarchive.
  profiles_var="$(tr '[:lower:]' '[:upper:]' <<< "$platform")_PROFILES_JSON"
  require "$profiles_var"
  profiles_json="${!profiles_var}"
  if [[ "$platform" == "macos" ]]; then
    require MAC_INSTALLER_SIGNING_CERTIFICATE
  fi
  require ASC_API_KEY_PATH APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID

  mkdir -p "$TESTFLIGHT_OUTPUT_DIR/exports/$platform"

  case "$platform" in
    ios)
      profile_uuid="$(resolve_profile "$profiles_json" "AppStore com.nickysemenza.cubby iOS" IOS_APP_STORE mobileprovision)"
      ios_export_options="$TESTFLIGHT_OUTPUT_DIR/ExportOptions-iOS.plist"
      write_export_options "$ios_export_options" "$profile_uuid"
      export_platform "$ios_archive" "$TESTFLIGHT_OUTPUT_DIR/exports/ios" "$ios_export_options"
      ;;
    macos)
      profile_uuid="$(resolve_profile "$profiles_json" "AppStore com.nickysemenza.cubby macOS" MAC_APP_STORE provisionprofile)"
      macos_export_options="$TESTFLIGHT_OUTPUT_DIR/ExportOptions-macOS.plist"
      write_export_options "$macos_export_options" "$profile_uuid" "$MAC_INSTALLER_SIGNING_CERTIFICATE"
      export_platform "$macos_archive" "$TESTFLIGHT_OUTPUT_DIR/exports/macos" "$macos_export_options"
      ;;
  esac
fi
