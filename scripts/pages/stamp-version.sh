#!/usr/bin/env bash
# Stamps a deployed copy of web/ with a version so open copies of the tracker (a browser tab, the
# iPhone home-screen app, a Safari "Add to Dock" app on a Mac) can notice a newer deploy and offer
# to restart (web/update-check.js). Run by .github/workflows/pages.yml; never on the committed web/.
#
#   scripts/pages/stamp-version.sh <web dir> <version>
#
# 1. writes <web dir>/version.json  {"version": "<version>"}
# 2. sets <meta name="app-version" content="..."> in index.html to <version>
# 3. adds ?v=<version> to the page's own .js and .css references (not CDN URLs), so a restart
#    loads the new files instead of copies the browser or GitHub Pages' cache still holds.
set -euo pipefail
dir="${1:?web dir}"; ver="${2:?version}"
case "$ver" in *[!A-Za-z0-9._-]*) echo "bad version: $ver" >&2; exit 1 ;; esac
printf '{"version":"%s"}\n' "$ver" > "$dir/version.json"
html="$dir/index.html"
grep -q '<meta name="app-version" content="dev">' "$html" || { echo "app-version meta not found in $html" >&2; exit 1; }
sed -i.bak -E \
  -e "s#<meta name=\"app-version\" content=\"dev\">#<meta name=\"app-version\" content=\"$ver\">#" \
  -e "s#(src|href)=\"([A-Za-z0-9_./-]+\\.(js|css))\"#\\1=\"\\2?v=$ver\"#g" \
  "$html"
rm -f "$html.bak"
echo "stamped $html and $dir/version.json with $ver"
