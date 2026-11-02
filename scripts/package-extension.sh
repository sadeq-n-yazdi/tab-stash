#!/bin/sh
# Packages the extension into dist/tab-stash-extension-<version>.zip.
#
# Usage, in the root folder of the repository:
#   scripts/package-extension.sh [expected-version] [commit]
#
# If expected-version is given, the script stops when manifest.json or
# package.json has a different version. The packaged manifest.json gets
# "version_name": "<version> (<short commit>)". Chrome shows it on
# chrome://extensions.
set -eu

version=$(jq -r .version extension/manifest.json)
pkg_version=$(jq -r .version package.json)
expected=${1:-}
commit=${2:-$(git rev-parse HEAD)}
short=$(printf '%.7s' "$commit")

if [ "$version" != "$pkg_version" ]; then
	echo "error: manifest.json has $version, package.json has $pkg_version" >&2
	exit 1
fi
if [ -n "$expected" ] && [ "$expected" != "$version" ]; then
	echo "error: the tag is $expected, but manifest.json has $version" >&2
	exit 1
fi

name=tab-stash-extension-$version
build=dist/$name
rm -rf "$build" "dist/$name.zip"
mkdir -p "$build"
cp -r extension/. "$build/"
jq --arg vn "$version ($short)" '.version_name = $vn' extension/manifest.json >"$build/manifest.json"

(cd "$build" && zip -qrX "../$name.zip" . -x '.*')
rm -rf "$build"
(cd dist && sha256sum -- "$name.zip" >"$name.zip.sha256")
echo "built dist/$name.zip (version $version, commit $short)"
