#!/bin/bash
cd "$(dirname "$0")"
npm start
# Ensure cage exits when the app does
kill $PPID
