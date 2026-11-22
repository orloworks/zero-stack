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
