# Backup and restore

```bash
infrastructure/scripts/backup.sh                       # pg_dump (custom format) + uploads archive + sha256, 14-day retention
infrastructure/scripts/restore.sh <file.dump> <new-db> # restores into a NEW database; refuses an existing name
infrastructure/scripts/verify-backup.sh                # backup -> restore to scratch -> compare every table's row count -> ledger balance check
```

* Run `backup.sh` from a scheduler (cron or your platform's job runner) at least daily, and before every upgrade. Copy the output off the
  host; a backup that lives only on the machine it protects is not a backup. Backups hold customer data (fictional here); the script writes
  them owner-readable only.
* Run `verify-backup.sh` on a schedule too. It proves the newest backup restores and that every journal in the restored ledger still balances.
* `restore.sh` never overwrites a live database. To recover: restore into a new name, inspect it, stop the stack, set `POSTGRES_DB` to the
  new name (or rename databases inside Postgres), start the stack.
* Redis holds only queues and short-lived state; it is not backed up. After a restore, scheduled work resumes from the database.

**Not covered:** point-in-time recovery (continuous WAL archiving), cross-region copies, encryption of backups at rest, and restore-time
objectives. A logical dump loses everything since the last backup.
