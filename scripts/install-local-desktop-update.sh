#!/bin/bash
# Install an already-built, certificate-signed local desktop app.
set -euo pipefail

source_app=${1:?Usage: bash scripts/install-local-desktop-update.sh /path/to/signed.app}
installed_app='/Applications/T3 Code (Alpha).app'
plist='Contents/Info.plist'

[[ -d "$source_app" && -d "$installed_app" ]] || { echo 'Both app bundles must exist.' >&2; exit 1; }
/usr/bin/codesign --verify --deep --strict "$source_app"
source_signature=$(/usr/bin/codesign -dvv "$source_app" 2>&1)
installed_signature=$(/usr/bin/codesign -dvv "$installed_app" 2>&1)
[[ "$source_signature" == *'Authority=Apple Development:'* ]] || {
  echo 'The update must be signed with an Apple Development certificate.' >&2; exit 1;
}
source_team=$(sed -n 's/^TeamIdentifier=//p' <<< "$source_signature")
installed_team=$(sed -n 's/^TeamIdentifier=//p' <<< "$installed_signature")
[[ -n "$source_team" && "$source_team" == "$installed_team" ]] || {
  echo 'Signing teams do not match.' >&2; exit 1;
}
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$installed_app/$plist")
[[ "$bundle_id" == "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$source_app/$plist")" ]] || {
  echo 'App bundle identifiers do not match.' >&2; exit 1;
}
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$source_app/$plist")
backup="/Applications/T3 Code (Alpha).backup-$(date +%Y%m%d-%H%M%S).app"
[[ ! -e "$backup" ]] || { echo "Backup already exists: $backup" >&2; exit 1; }

echo "Update: $version"
echo "Source: $source_app"
echo "Destination: $installed_app"
echo "Backup: $backup"
echo 'Finish local turns, subagents, and managed terminals before continuing.'
echo 'Record your open panes so you can check them after reopening.'
read -r -p 'Type update when it is safe to quit the installed app: ' answer
[[ "$answer" == update ]] || exit 1

stage_dir=$(mktemp -d '/Applications/.t3-desktop-update.XXXXXX')
cleanup() { rm -rf "$stage_dir"; }
trap cleanup EXIT
staged_app="$stage_dir/T3 Code (Alpha).app"
/usr/bin/ditto "$source_app" "$staged_app"
/usr/bin/codesign --verify --deep --strict "$staged_app"
/usr/bin/osascript -e 'tell application "/Applications/T3 Code (Alpha).app" to quit'

# Inspect only. Never signal processes found by name or path.
for ((attempt = 0; attempt < 30; attempt++)); do
  if ! /bin/ps -axo command= | /usr/bin/grep -F "$installed_app/Contents/" | /usr/bin/grep -v '/usr/bin/grep' >/dev/null; then
    break
  fi
  sleep 1
done
if /bin/ps -axo command= | /usr/bin/grep -F "$installed_app/Contents/" | /usr/bin/grep -v '/usr/bin/grep' >/dev/null; then
  echo 'The installed app still has running processes. No replacement was made.' >&2
  exit 1
fi

mv "$installed_app" "$backup"
if ! mv "$staged_app" "$installed_app"; then
  mv "$backup" "$installed_app"
  echo 'Replacement failed; restored the previous app.' >&2
  exit 1
fi
/usr/bin/open "$installed_app"
echo "Installed $version. Previous app: $backup"
echo 'Check that your connections, threads, and panes reappear and a new thread selects Astra.'
