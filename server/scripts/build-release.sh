#!/bin/sh
# Builds the release archives of tab-stash-server into dist/.
#
# Usage, in the folder "server":
#   scripts/build-release.sh <version> [commit]
#
# The binaries contain the version and the git commit. They show them with
# "tab-stash-server version" and on GET /healthz. Set TARGETS to build for
# other systems, for example TARGETS="linux/amd64".
set -eu

version=${1:?usage: scripts/build-release.sh <version> [commit]}
commit=${2:-$(git rev-parse HEAD)}
targets=${TARGETS:-linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64}

if ! printf '%s\n' "$version" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?'; then
	echo "error: \"$version\" is not a version like 1.2.3 (without \"v\")" >&2
	exit 1
fi

rm -rf dist
mkdir -p dist
for target in $targets; do
	os=${target%/*}
	arch=${target#*/}
	name=tab-stash-server-$version-$os-$arch
	exe=tab-stash-server
	[ "$os" = windows ] && exe=tab-stash-server.exe

	mkdir -p "dist/$name"
	CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath \
		-ldflags "-s -w -X main.version=$version -X main.commit=$commit" \
		-o "dist/$name/$exe" ./cmd/tab-stash-server
	cp README.md ../LICENSE "dist/$name/"
	cp -r deploy "dist/$name/"

	if [ "$os" = windows ]; then
		(cd dist && zip -qr "$name.zip" "$name")
	else
		tar -C dist -czf "dist/$name.tar.gz" "$name"
	fi
	rm -rf "dist/${name:?}"
	echo "built dist/$name"
done

(cd dist && sha256sum -- * >SHA256SUMS)
echo "wrote dist/SHA256SUMS"
