-- 0009 · Two-factor sign-in for our console staff (HANDOVER §16 #7).
--
-- A time-based one-time password (RFC 6238: SHA-1, 30 seconds, six digits)
-- from an authenticator app, on top of the password. Set up in two steps: a
-- secret is issued (totp_secret, not yet enabled), then a code from the app
-- proves it was saved (totp_enabled_at). Once enabled, sign-in needs a code.
--
-- totp_last_step is the last 30-second step a code was accepted for, so a
-- code seen over someone's shoulder cannot be used a second time.

alter table platform_staff
  add column totp_secret     text check (totp_secret ~ '^[A-Z2-7]{16,64}$'),
  add column totp_enabled_at timestamptz,
  add column totp_last_step  bigint,
  add constraint platform_staff_totp_needs_secret check (totp_enabled_at is null or totp_secret is not null);
