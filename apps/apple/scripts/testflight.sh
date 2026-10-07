#!/usr/bin/env bash
# Archive, verify, and export/upload one Cubby Apple app platform. GitHub
# Actions owns runner credentials and runs one job per platform (see
# .github/workflows/apple-testflight.yaml); this script owns the Xcode
# contract. The marketing version comes from the generated project settings;
# RELEASE_VERSION is what the planner expects them to carry.
set -euo pipefail

usage() {
  echo "usage: $0 <ios|macos>" >&2
  echo "env: RELEASE_VERSION RELEASE_BUILD_NUMBER TESTFLIGHT_OUTPUT_DIR PROFILES_JSON" >&2
  echo "     ASC_API_KEY_PATH APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID" >&2
  echo "     GITHUB_TOKEN plus the run's GITHUB_* variables (the pre-upload guard)" >&2
  echo "  (iOS also needs IOS_LIVE_ACTIVITY_PROFILES_JSON)" >&2
  echo "  (macOS also needs MAC_INSTALLER_SIGNING_CERTIFICATE)" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi
platform="$1"
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

require RELEASE_VERSION RELEASE_BUILD_NUMBER TESTFLIGHT_OUTPUT_DIR PROFILES_JSON \
  ASC_API_KEY_PATH APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID

readonly team_id="Y9A97FXT63"
readonly bundle_id="com.nickysemenza.cubby"
readonly live_activity_bundle_id="$bundle_id.LiveActivity"
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
  local profile_bundle_id="${5:-$bundle_id}"
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

  decoded="$TESTFLIGHT_OUTPUT_DIR/${uuid}.plist"
  security cms -D -i "$path" > "$decoded"
  [[ "$(plutil -extract Name raw -o - "$decoded")" == "$expected_name" ]]
  [[ "$(plutil -extract TeamIdentifier.0 raw -o - "$decoded")" == "$team_id" ]]
  identifier_key="application-identifier"
  [[ "$expected_type" == "MAC_APP_STORE" ]] && identifier_key="com.apple.application-identifier"
  profile_app_identifier="$(
    /usr/libexec/PlistBuddy -c "Print :Entitlements:$identifier_key" "$decoded"
  )"
  [[ "$profile_app_identifier" == "$team_id.$profile_bundle_id" ]]
  if [[ "$profile_bundle_id" == "$bundle_id" ]]; then
    # App Store profiles authorize the capability with `*`; the signed app's
    # entitlements retain the exact applinks domain from the target.
    associated_domains="$(
      /usr/libexec/PlistBuddy \
        -c 'Print :Entitlements:com.apple.developer.associated-domains' "$decoded"
    )"
    grep -Eq '^\*$|applinks:cubby\.nickysemenza\.com' <<< "$associated_domains"
  fi

  printf '%s' "$uuid"
}

resolve_live_activity_profile() {
  resolve_profile "$IOS_LIVE_ACTIVITY_PROFILES_JSON" \
    "AppStore $live_activity_bundle_id iOS" IOS_APP_STORE mobileprovision "$live_activity_bundle_id"
}

write_export_options() {
  local path="$1"
  local profile_uuid="$2"
  local destination="upload"
  local installer_certificate="${3:-}"
  local live_activity_profile_uuid="${4:-}"

  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0"><dict/></plist>' > "$path"
  /usr/libexec/PlistBuddy -c "Add :destination string $destination" "$path"
  /usr/libexec/PlistBuddy -c 'Add :manageAppVersionAndBuildNumber bool false' "$path"
  /usr/libexec/PlistBuddy -c 'Add :method string app-store-connect' "$path"
  /usr/libexec/PlistBuddy -c 'Add :provisioningProfiles dict' "$path"
  /usr/libexec/PlistBuddy -c "Add :provisioningProfiles:$bundle_id string $profile_uuid" "$path"
  if [[ -n "$live_activity_profile_uuid" ]]; then
    /usr/libexec/PlistBuddy \
      -c "Add :provisioningProfiles:$live_activity_bundle_id string $live_activity_profile_uuid" "$path"
  fi
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
  shift 4

  xcodebuild archive \
    -project "$project" \
    -scheme "$scheme" \
    -configuration Release \
    -destination "$destination" \
    -archivePath "$archive" \
    -derivedDataPath "$derived_data" \
    -skipPackagePluginValidation \
    CUBBY_PROVISIONING_PROFILE_SPECIFIER="$profile_uuid" \
    CURRENT_PROJECT_VERSION="$RELEASE_BUILD_NUMBER" \
    COMPILER_INDEX_STORE_ENABLE=NO \
    "$@"
}

verify_archive() {
  local archive="$1"
  local app="$2"
  local info="$3"
  local privacy_manifest="$4"
  local embedded_profile="$5"
  local check_macos_category="${6:-false}"

  [[ -d "$app" ]]
  # The generated MARKETING_VERSION must be the version the server's minimum
  # was set from, or the server would refuse (HTTP 426) the build it ships.
  [[ "$(plutil -extract CFBundleShortVersionString raw -o - "$info")" == "$RELEASE_VERSION" ]] || {
    echo "error: $info does not carry the planned version $RELEASE_VERSION" >&2
    exit 1
  }
  [[ "$(plutil -extract CFBundleVersion raw -o - "$info")" == "$RELEASE_BUILD_NUMBER" ]]
  [[ -f "$privacy_manifest" && -f "$embedded_profile" ]]
  # v1.0.7 archived fine but App Store Connect rejected the upload (90360)
  # because the Live Activity extension had no CFBundleDisplayName.
  local extension
  while IFS= read -r -d '' extension; do
    [[ -n "$(plutil -extract CFBundleDisplayName raw -o - "$extension/Info.plist" 2>/dev/null || true)" ]] || {
      echo "error: $extension/Info.plist is missing CFBundleDisplayName" >&2
      exit 1
    }
  done < <(find "$app" -name '*.appex' -type d -print0)
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
  xcodebuild -exportArchive \
    -archivePath "$archive" \
    -exportPath "$output" \
    -exportOptionsPlist "$options" \
    -authenticationKeyPath "$ASC_API_KEY_PATH" \
    -authenticationKeyID "$APP_STORE_CONNECT_KEY_ID" \
    -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID"
}

export_options="$TESTFLIGHT_OUTPUT_DIR/ExportOptions-$platform.plist"
case "$platform" in
  ios)
    require IOS_LIVE_ACTIVITY_PROFILES_JSON
    profile_uuid="$(resolve_profile "$PROFILES_JSON" "AppStore com.nickysemenza.cubby iOS" IOS_APP_STORE mobileprovision)"
    live_activity_profile_uuid="$(resolve_live_activity_profile)"
    archive_platform Cubby-iOS 'generic/platform=iOS' "$ios_archive" "$profile_uuid" \
      CUBBY_LIVE_ACTIVITY_PROVISIONING_PROFILE_SPECIFIER="$live_activity_profile_uuid"
    verify_archive \
      "$ios_archive" \
      "$ios_archive/Products/Applications/Cubby.app" \
      "$ios_archive/Products/Applications/Cubby.app/Info.plist" \
      "$ios_archive/Products/Applications/Cubby.app/PrivacyInfo.xcprivacy" \
      "$ios_archive/Products/Applications/Cubby.app/embedded.mobileprovision"
    write_export_options "$export_options" "$profile_uuid" "" "$live_activity_profile_uuid"
    archive="$ios_archive"
    ;;
  macos)
    require MAC_INSTALLER_SIGNING_CERTIFICATE
    profile_uuid="$(resolve_profile "$PROFILES_JSON" "AppStore com.nickysemenza.cubby macOS" MAC_APP_STORE provisionprofile)"
    archive_platform Cubby-macOS 'generic/platform=macOS' "$macos_archive" "$profile_uuid" ARCHS=arm64
    verify_archive \
      "$macos_archive" \
      "$macos_archive/Products/Applications/Cubby.app" \
      "$macos_archive/Products/Applications/Cubby.app/Contents/Info.plist" \
      "$macos_archive/Products/Applications/Cubby.app/Contents/Resources/PrivacyInfo.xcprivacy" \
      "$macos_archive/Products/Applications/Cubby.app/Contents/embedded.provisionprofile" \
      true
    write_export_options "$export_options" "$profile_uuid" "$MAC_INSTALLER_SIGNING_CERTIFICATE"
    archive="$macos_archive"
    ;;
esac

# Archiving takes long enough for another run to start; never upload a build
# number a newer run may already have used.
node scripts/apple-release.ts guard
mkdir -p "$TESTFLIGHT_OUTPUT_DIR/exports/$platform"
export_platform "$archive" "$TESTFLIGHT_OUTPUT_DIR/exports/$platform" "$export_options"
