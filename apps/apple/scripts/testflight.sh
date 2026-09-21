#!/usr/bin/env bash
# Archive, verify, and export/upload both Cubby Apple apps. GitHub Actions owns
# runner credentials; this script owns the platform ordering and Xcode contract.
set -euo pipefail

usage() {
  echo "usage: $0 <validate|upload>" >&2
  echo "required env: MARKETING_VERSION IOS_BUILD_NUMBER MACOS_BUILD_NUMBER" >&2
  echo "              IOS_PROFILES_JSON MACOS_PROFILES_JSON TESTFLIGHT_OUTPUT_DIR" >&2
}

if [[ $# -ne 1 || ( "$1" != "validate" && "$1" != "upload" ) ]]; then
  usage
  exit 2
fi
mode="$1"

required=(
  MARKETING_VERSION
  IOS_BUILD_NUMBER
  MACOS_BUILD_NUMBER
  IOS_PROFILES_JSON
  MACOS_PROFILES_JSON
  TESTFLIGHT_OUTPUT_DIR
)
if [[ "$mode" == "upload" ]]; then
  required+=(ASC_API_KEY_PATH APP_STORE_CONNECT_KEY_ID APP_STORE_CONNECT_ISSUER_ID)
fi
for variable in "${required[@]}"; do
  [[ -n "${!variable:-}" ]] || {
    echo "error: required environment variable $variable is empty" >&2
    exit 1
  }
done

readonly team_id="Y9A97FXT63"
readonly bundle_id="com.nickysemenza.cubby"
readonly ios_profile_name="AppStore com.nickysemenza.cubby iOS"
readonly macos_profile_name="AppStore com.nickysemenza.cubby macOS"
readonly project="apps/apple/Cubby.xcodeproj"
readonly derived_data="$TESTFLIGHT_OUTPUT_DIR/DerivedData"
readonly ios_archive="$TESTFLIGHT_OUTPUT_DIR/Cubby-iOS.xcarchive"
readonly macos_archive="$TESTFLIGHT_OUTPUT_DIR/Cubby-macOS.xcarchive"

mkdir -p "$TESTFLIGHT_OUTPUT_DIR/exports/ios" "$TESTFLIGHT_OUTPUT_DIR/exports/macos"

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

ios_profile_uuid="$(resolve_profile "$IOS_PROFILES_JSON" "$ios_profile_name" IOS_APP_STORE mobileprovision)"
macos_profile_uuid="$(resolve_profile "$MACOS_PROFILES_JSON" "$macos_profile_name" MAC_APP_STORE provisionprofile)"

write_export_options() {
  local path="$1"
  local profile_uuid="$2"
  local destination="export"
  local installer_certificate="${3:-}"
  [[ "$mode" == "upload" ]] && destination="upload"

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

readonly ios_export_options="$TESTFLIGHT_OUTPUT_DIR/ExportOptions-iOS.plist"
readonly macos_export_options="$TESTFLIGHT_OUTPUT_DIR/ExportOptions-macOS.plist"
write_export_options "$ios_export_options" "$ios_profile_uuid"
write_export_options "$macos_export_options" "$macos_profile_uuid" "Mac Installer Distribution"

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
    CUBBY_PROVISIONING_PROFILE_SPECIFIER="$profile_uuid" \
    MARKETING_VERSION="$MARKETING_VERSION" \
    CURRENT_PROJECT_VERSION="$build_number" \
    COMPILER_INDEX_STORE_ENABLE=NO \
    "$@"
}

# Neither platform uploads unless both archives exist.
archive_platform Cubby-iOS 'generic/platform=iOS' "$ios_archive" "$ios_profile_uuid" "$IOS_BUILD_NUMBER"
archive_platform Cubby-macOS 'generic/platform=macOS' "$macos_archive" "$macos_profile_uuid" "$MACOS_BUILD_NUMBER" ARCHS=arm64

verify_archive() {
  local archive="$1"
  local app="$2"
  local info="$3"
  local privacy_manifest="$4"
  local embedded_profile="$5"
  local build_number="$6"

  [[ -d "$app" ]]
  [[ "$(plutil -extract CFBundleShortVersionString raw -o - "$info")" == "$MARKETING_VERSION" ]]
  [[ "$(plutil -extract CFBundleVersion raw -o - "$info")" == "$build_number" ]]
  [[ -f "$privacy_manifest" && -f "$embedded_profile" ]]
  codesign --verify --deep --strict --verbose=2 "$app"
  find "$archive/dSYMs" -name '*.dSYM' -print -quit | grep -q .
  xcrun dwarfdump --uuid "$archive/dSYMs/Cubby.app.dSYM"
}

verify_archive \
  "$ios_archive" \
  "$ios_archive/Products/Applications/Cubby.app" \
  "$ios_archive/Products/Applications/Cubby.app/Info.plist" \
  "$ios_archive/Products/Applications/Cubby.app/PrivacyInfo.xcprivacy" \
  "$ios_archive/Products/Applications/Cubby.app/embedded.mobileprovision" \
  "$IOS_BUILD_NUMBER"
verify_archive \
  "$macos_archive" \
  "$macos_archive/Products/Applications/Cubby.app" \
  "$macos_archive/Products/Applications/Cubby.app/Contents/Info.plist" \
  "$macos_archive/Products/Applications/Cubby.app/Contents/Resources/PrivacyInfo.xcprivacy" \
  "$macos_archive/Products/Applications/Cubby.app/Contents/embedded.provisionprofile" \
  "$MACOS_BUILD_NUMBER"

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
  if [[ "$mode" == "upload" ]]; then
    arguments+=(
      -authenticationKeyPath "$ASC_API_KEY_PATH"
      -authenticationKeyID "$APP_STORE_CONNECT_KEY_ID"
      -authenticationKeyIssuerID "$APP_STORE_CONNECT_ISSUER_ID"
    )
  fi
  xcodebuild "${arguments[@]}"
}

export_platform "$ios_archive" "$TESTFLIGHT_OUTPUT_DIR/exports/ios" "$ios_export_options"
export_platform "$macos_archive" "$TESTFLIGHT_OUTPUT_DIR/exports/macos" "$macos_export_options"
