# FlowVision recovery kit

This folder sits on the backup drive next to the FlowVision backups. With it, a **new computer** can recover
FlowVision's data even if the original backup computer, its Windows account, its settings and the FlowVision
installation are all gone.

## What you need

| Item | Where it comes from |
|---|---|
| This drive | The backups (`flowvision_full_….zip.fvenc`), their records (`….json`), this kit, and the Restic repository if one is used |
| The **backup passphrase** | The sealed envelope or password manager it was stored in. It is **not** on this drive or in any backup. |
| The **Restic repository password** (only for Restic snapshots) | Stored the same way as the passphrase |
| Node.js 18 or newer | https://nodejs.org (the LTS installer). Nothing else is installed with npm. |
| MariaDB server and client, the same major version as the backup (see `….json`, `summary.server_version`) or newer | https://mariadb.org/download |
| Restic (only for Restic snapshots) | https://restic.net, or `winget install restic.restic` |

## Recover from a full backup (`.zip.fvenc`)

1. Copy the newest backup file from this drive to the new computer, for example `C:\Recovery\`.
   Its record `….json` shows when it was made and whether it was verified (`status`).
2. In a terminal (PowerShell or Command Prompt), in this folder:

   ```
   node flowvision-recover.mjs prepare C:\Recovery\flowvision_full_2026-11-08_20-00-03.zip.fvenc C:\Recovery\unpacked
   ```

   Type the passphrase when asked. It is not shown on screen. The kit:
   - decrypts the file, checking every block (a wrong passphrase or a damaged file is reported, never half-restored);
   - unzips it;
   - checks the SHA-256 of every entry;
   - unpacks the database dump to `unpacked\database\flowvision.sql`.

   It ends with `OK:` only if everything matched. Anything else means do not use that copy: try the next newest backup.
3. Create an empty database and load the dump (here `flowvision`):

   ```
   mariadb.exe -u root -p -e "CREATE DATABASE flowvision CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
   mariadb.exe --default-character-set=utf8mb4 --max-allowed-packet=1G -u root -p flowvision < C:\Recovery\unpacked\database\flowvision.sql
   ```

   If it stops with "Access denied; you need the SUPER privilege" on a view or trigger, the restoring account may not
   create objects owned by another account. Restore as `root`, or remove the `DEFINER=…` parts from those lines.
4. Uploaded files:
   - Files kept **in the database** (`file_blobs`, the hosted/Vercel setup) are already restored by step 3.
   - Files kept **on disk** are in `unpacked\files\`. That folder becomes FlowVision's `UPLOAD_DIR`.
5. Get the FlowVision application (its source code, from the project's repository), run `npm install`, point its
   `.env` at the restored database (`DB_*`) and, for files on disk, `UPLOAD_DIR` at `unpacked\files`. Open several
   documents, their files and their QR routing slips before anyone uses it.

   With the application available, `npm run backup -- restore` does steps 3–4 and then checks every table, row count
   and document-to-file link (see `docs/BACKUP_AND_RECOVERY.md`).

## Recover from a Restic snapshot

```
set RESTIC_REPOSITORY=E:\FlowVisionBackups\restic-repo
restic snapshots
restic restore latest --target C:\Recovery\snapshot
```

Restic asks for the repository password. The backup is inside the restored folder, under the path it had on the old
computer, for example `C:\Recovery\snapshot\D\FlowVisionBackups\restic-staging`. Then:

```
node flowvision-recover.mjs prepare C:\Recovery\snapshot\D\FlowVisionBackups\restic-staging C:\Recovery\unpacked
```

and continue with step 3 above. Snapshot folders are not encrypted by FlowVision; Restic encrypts the repository.

## Formats (for anyone who has to do this without the kit)

- **Package** (`flowvision-backup` v1): a zip with `manifest.json`, `CHECKSUMS.sha256` (`<sha256> *<path>`),
  `RESTORE.md`, `database/flowvision.sql.gz` (gzip; `mariadb-dump --single-transaction --hex-blob --routines --triggers`)
  and `files/<storage key>`.
- **Encryption** (`.zip.fvenc`, "FVBKENC1"):
  - Header: `FVBKENC1`, version byte `1`, KDF byte `1` (scrypt), `log2 N`, `r`, `p`, 16-byte salt, 8-byte nonce
    prefix, 4-byte big-endian chunk size.
  - Key: `scrypt(passphrase in Unicode NFC, salt, 32 bytes, N = 2^log2N, r, p)`.
  - Then chunks of `last flag (1 byte)`, `length (4 bytes, big-endian)`, AES-256-GCM ciphertext and a 16-byte tag.
    The nonce is the prefix plus a 4-byte big-endian chunk counter. The additional data is the header plus the last
    flag and the counter. The chunk marked last ends the file.
