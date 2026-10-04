-- 0007 · Removing a member keeps the audit trail.
--
-- audit_log.actor_member_id restricted deleting a membership whose holder had
-- ever done anything audited, so "remove from the unit" could only switch
-- them off. The trail does not need the membership row: actor_user_id still
-- names the person, and the row keeps its property and action. The column is
-- cleared instead; nothing else in the row changes.

alter table audit_log drop constraint audit_log_actor_member_id_fkey;
alter table audit_log add constraint audit_log_actor_member_id_fkey
  foreign key (actor_member_id) references property_members (id) on delete set null;
