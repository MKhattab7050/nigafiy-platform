#!/bin/sh
# Moves a Linux Sensor installed with the old standalone program (/usr/local/bin/nigafiy-sensor,
# or /usr/local/bin/lan-collector from before the rename) to the one Nigafiy executable,
# nigafiy-engine (docs/architecture/engine-sensor.md).
#
#   sudo sh upgrade-to-engine.sh /path/to/new/nigafiy-engine
#
# What it does:
#   1. installs the new executable as /usr/local/bin/nigafiy-engine (mode 0755, owned by root);
#   2. replaces /usr/local/bin/nigafiy-sensor and, if present, /usr/local/bin/lan-collector with
#      links to it. The executable runs the Sensor when it is called by one of those names, so the
#      existing unit (ExecStart=/usr/local/bin/nigafiy-sensor -config …) keeps working unchanged;
#   3. restarts lan-collector.service if it is installed.
# State (/var/lib/lan-collector), configuration (/etc/lan-collector/), the unit's name and its user
# do not change; the Sensor keeps its enrollment. Copying the new unit file
# (ExecStart=/usr/local/bin/nigafiy-engine sensor -config …) is optional.
#
# Not run in the development environment (Windows, no Linux machine); review before use.
set -eu

src=${1:-}
bin=/usr/local/bin
if [ -z "$src" ] || [ ! -f "$src" ]; then
	echo "usage: $0 /path/to/new/nigafiy-engine" >&2
	exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
	echo "run as root (sudo)" >&2
	exit 2
fi

# Refuse anything that is not the Nigafiy executable with the sensor mode.
if ! out=$("$src" sensor -version 2>/dev/null) || [ "${out#nigafiy-sensor }" = "$out" ]; then
	echo "$src does not answer 'sensor -version' like nigafiy-engine; not installing it" >&2
	exit 1
fi

install -m 0755 -o root -g root "$src" "$bin/nigafiy-engine.new"
mv -f "$bin/nigafiy-engine.new" "$bin/nigafiy-engine"
echo "installed $bin/nigafiy-engine ($out)"

for old in nigafiy-sensor lan-collector; do
	if [ "$old" = nigafiy-sensor ] || [ -e "$bin/$old" ] || [ -L "$bin/$old" ]; then
		ln -sfn nigafiy-engine "$bin/$old"
		echo "$bin/$old -> nigafiy-engine"
	fi
done

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files lan-collector.service >/dev/null 2>&1; then
	systemctl restart lan-collector.service
	echo "restarted lan-collector.service"
fi
