# zero-stack

A scaffolder for Void (Cloudflare) apps. These terms describe what a generated app's owner and users see.

## Access

**Invited address**:
An email address, or a whole domain, that is allowed to create an account in an invite-only app.
_Avoid_: whitelist, allowed user

**Admin**:
A signed-in user with a verified email that is on the app's admin list. Only the app owner can grant or revoke admin, by editing that list.
_Avoid_: superuser, staff, moderator

**Ban**:
An admin's block on a user. It ends the user's sessions and refuses new sign-ins until an admin lifts it. Users see it as their account being "blocked".
_Avoid_: suspension, lock, disable

## Admin area

**Audit entry**:
A record of one change an admin made: who made it, what changed, which user it affected, and when. Viewing a page is never recorded.
_Avoid_: log line, event, activity

**Invite**:
An invited address that an admin added in the admin area. It lasts until an admin revokes it.
_Avoid_: invitation code, token

**Onboarding step**:
One milestone in a fixed sequence that the app defines for new users. A user's progress is the steps they have reached.
_Avoid_: stage, checklist item

**Feature**:
A named capability that the app declares and checks before letting a user use it.
_Avoid_: flag (that is the switch, not the capability), toggle, permission

**Feature switch**:
An admin's setting for one feature: on, off, or kill switch for everyone, plus overrides for individual users.
_Avoid_: feature flag

**Setting**:
A value that the app declares with a type and a default, and that an admin can change while the app runs. It is never a secret.
_Avoid_: config, option, env var

## Upgrades

**Upgrade**:
Bringing a generated app to a newer zero-stack: scaffold-owned files move to the new version and upstream changes are merged into app-owned files. It never commits and never migrates the database.
_Avoid_: update (that is for packages), sync, regenerate

**Scaffold-owned file**:
A file in a generated app that zero-stack maintains. It says so in its first lines, and an upgrade brings it to the new version. An app changes what it does through app-owned files, not by editing it.
_Avoid_: generated file (every file in a new app is generated), machinery, vendor file

**App-owned file**:
A file in a generated app that belongs to the app after the first scaffold: its declaration files, its auth extension, its user-facing pages and its configuration. An upgrade merges upstream changes into it and never discards the app's edits.
_Avoid_: user file, custom file

**Declaration file**:
An app-owned file that holds only one of the app's lists: its features, settings, onboarding steps or plans.
_Avoid_: config file, registry

**Auth extension**:
The app-owned file where an app adds its own sign-in plugins and trusted origins to the scaffold-owned auth setup.
_Avoid_: auth override, auth config

**Manifest**:
The record in a generated app of what it was made from: the zero-stack version, the app's name and framework, and its flags.
_Avoid_: lockfile, config

**Base copy**:
The copy, kept in the app, of each file as zero-stack last generated it. An upgrade compares against it to tell the app's edits from upstream changes.
_Avoid_: snapshot, cache
