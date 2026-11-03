#!/bin/bash
# Paste this as "user data" (DigitalOcean: Advanced options -> Add initialization scripts; AWS EC2: Advanced
# details -> User data; Lightsail: Add launch script) when creating an Ubuntu 22.04/24.04 server. It installs Relay
# on first boot, about 5 minutes.
#
# Pick a setup code below (8+ characters) and you won't need to log in at all: once it's up, enter
# https://<ip-with-dashes>.sslip.io (or your domain) and that code in the app. Leave it empty to have one generated;
# then SSH in, and the login message shows it.
#
# For your own domain, set RELAY_DOMAIN below and point its A record at the server's IP before it boots
# (or leave it empty and use the free https://<ip-with-dashes>.sslip.io address).
export RELAY_SETUP_CODE=""
export RELAY_DOMAIN=""
export RELAY_REPO="https://github.com/seika5/relay.git"
export RELAY_BRANCH="main"

set -e
exec > /var/log/relay-install.log 2>&1
apt-get update -q && apt-get install -y -q git
git clone -q --depth 1 --branch "$RELAY_BRANCH" "$RELAY_REPO" /opt/relay
bash /opt/relay/relay-server/deploy/install.sh
