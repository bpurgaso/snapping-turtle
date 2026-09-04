# Built by client-linux/scripts/package-rpm.sh, which passes:
#   --define "version <Cargo.toml version>"  --define "app_id <CLIENT_APP_ID>"
#   --define "staging <dir with usr/...>"     (the already-built tree)
# The binary is compiled by cargo outside rpmbuild so the same artifact is
# what CI tested; the spec only lays files out and records dependencies.
%global debug_package %{nil}

Name:           snapping-turtle
Version:        %{version}
Release:        1%{?dist}
Summary:        Native Linux capture client for snapping-turtle
License:        All rights reserved
URL:            https://github.com/bpurgaso/snapping-turtle
BuildArch:      x86_64

# The portal frontend (Screenshot, OpenURI, Notification, GlobalShortcuts,
# Background); a backend for the running desktop provides the dialogs.
Requires:       xdg-desktop-portal
Requires:       hicolor-icon-theme
Recommends:     xdg-desktop-portal-kde
Recommends:     xdg-desktop-portal-gtk

%description
Tray-resident screenshot client for a self-hosted snapping-turtle server:
full-screen, region and window capture through the XDG Desktop Portal and,
on KDE Plasma, KWin's ScreenShot2 interface; uploads with a personal API
token and opens the annotation page in the default browser.
Application id: %{app_id}

%prep
%build

%install
cp -a %{staging}/. %{buildroot}/

%files
%{_bindir}/snapping-turtle
%{_datadir}/applications/%{app_id}.desktop
%{_datadir}/icons/hicolor/*/apps/snapping-turtle.png
%{_datadir}/icons/hicolor/scalable/apps/snapping-turtle.svg
%doc %{_docdir}/snapping-turtle/README.md
%doc %{_docdir}/snapping-turtle/TESTING.md

%changelog
%autochangelog
