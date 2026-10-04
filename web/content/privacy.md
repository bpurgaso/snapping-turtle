# snapping-turtle privacy policy

This policy covers every snapping-turtle client — the browser extensions for
Chrome and Firefox and the desktop client for Linux — and the snapping-turtle
server they upload to.

## Where your data goes

A client sends data only to the snapping-turtle server configured in its
settings — by default the server it was built for, otherwise the one you
entered. It never sends anything to the software's authors or to any third
party, and it contains no analytics, telemetry or advertising.

## What is sent

Only when you trigger a capture: the screenshot image, the URL and title of
the captured page (a desktop capture has no page, so it carries a generated
title and no URL), and your API token as an authorization header. The server
stores the image, the URL and title, the uploading account, the token used
and the upload IP address, and deletes the image when its retention period
ends (30 days by default, extendable by the owner; the server's operator
controls the policy).

## What is stored on your device

- **Browser extensions:** the server address, your API token, the last-used
  capture mode and whether region suggestions are switched on, in the
  extension's local storage in your browser.
- **Desktop client:** the server address and the client's own settings in its
  configuration file, and your API token in your system keyring (or in a
  private file, if you chose that).

Removing the extension, or the desktop client's configuration, deletes them.

## Who can see a capture

Anyone who has its link. Links are unguessable; treat them as you would the
screenshot itself. The server's operator (the person running it) can see
every capture uploaded to it.
