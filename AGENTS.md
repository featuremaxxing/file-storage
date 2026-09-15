# AGENTS.md – featuremaxxing/file-storage

**Dieses Repo:** Dateidienst für Räume und Boards unter `/api/v3/file` (S3/MinIO, Vorschau-Generator).

Fork von `hpi-schul-cloud/file-storage`. Code-Stil, Tests und Konventionen des Upstream-Repos gelten weiter (README, ESLint).

## Feature-Workflow: Branch → staging.kibox.online → kibox.online

Für Menschen und LLMs. Kurz: **Branch + PR im Fork, Label `staging` setzen, testen, mergen.**

## Umgebungen

| Umgebung | URL | Zeigt | Daten |
|---|---|---|---|
| Live | https://kibox.online | `main` aller Forks | dauerhaft |
| Staging | https://staging.kibox.online | genau **einen** Feature-Branch | Kopie von Live beim Hochfahren |

Repos (Forks von `hpi-schul-cloud`), Default-Branch jeweils `main`:
`featuremaxxing/schulcloud-server`, `featuremaxxing/schulcloud-client` (Legacy-UI), `featuremaxxing/nuxt-client` (Vue-UI), `featuremaxxing/file-storage`.

## Ablauf

1. **Branch** vom aktuellen `main` des Forks anlegen: `feature/<kurzname>` (erlaubt: `A-Z a-z 0-9 . _ / -`).
   Betrifft das Feature mehrere Repos, **denselben Branch-Namen in jedem Repo** verwenden.
2. **Push** in den Fork unter `featuremaxxing` und **PR gegen `main` desselben Forks** öffnen.
3. **Label `staging`** an den PR setzen (bei mehreren Repos an einen oder alle PRs).
4. **Warten** (~2 Min. + Build 1–4 Min.). Im PR erscheint:
   - `🚀 Staging aktiv` mit Link und Ständen je Komponente, oder
   - `⚠️ Staging fehlgeschlagen` mit Log-Pfad. Fix pushen → neuer Versuch.
5. **Testen** auf https://staging.kibox.online (gleiche Logins wie Live, Banner zeigt den Branch).
   Weitere Commits auf den Branch werden automatisch nachgezogen, Daten bleiben erhalten.
6. **Übernehmen:** PR(s) nach `main` mergen, bei mehreren Repos `schulcloud-server` zuerst.
   Live deployt jeden Merge automatisch (~2 Min. + Build, Server inkl. Migrationen).
   Staging fährt herunter, sobald kein offener PR mehr das Label hat.
7. **Abbrechen:** Label entfernen oder PR schließen.

## Regeln

- Niemals direkt auf `main` pushen (Ruleset erzwingt PRs). Keine PRs an `hpi-schul-cloud`.
- PRs müssen aus einem Branch **im `featuremaxxing`-Repo selbst** kommen, nicht aus einem weiteren Fork.
- Es gibt **einen** Staging-Slot. Das zuletzt gesetzte Label gewinnt, der verdrängte PR bekommt einen Kommentar.
- Jeder Wechsel auf ein anderes Feature setzt die Staging-Daten auf den Stand von Live zurück.
- Repos ohne den Branch laufen auf Staging mit dem Live-Stand.
- Der Build nutzt das `Dockerfile` des Repos und muss ohne Zusatzschritte durchlaufen.
- **Feature-Flags / Umgebungsvariablen:** Default im Code bleibt „aus“. Den Wert setzt ein PR in `featuremaxxing/nbc-teststack` (`compose.yml`, Server-Flags unter `x-server-env`). Nach dem Hochladen übernimmt Staging ihn automatisch ohne Datenverlust. Live übernimmt ihn per `docker compose up -d <services>`. Solange Live den Code nicht hat, wird das Flag dort ignoriert.
- Mails werden auch aus Staging **wirklich verschickt** (SMTP). Keine fremden Adressen verwenden.
- Nicht vorhanden, daher nicht testbar: Etherpad, Collabora, H5P, tldraw, BigBlueButton, Kalender, Virenscan, moin.schule/OAuth, Nextcloud.
- Upstream-Stand holen: „Sync fork“ auf GitHub. Das deployt Live neu.

## Server (nur mit SSH-Zugang)

```bash
nbc status                    # Live-Komponenten, Staging, Container
nbc stage status              # was läuft auf Staging
nbc stage <branch>            # Branch von Hand hochfahren (Vorrang vor Labels)
nbc stage off                 # Staging aus
nbc logs server -f            # Live-Logs
nbc stage logs stg-server -f  # Staging-Logs
nbc history                   # letzte Deploys
```

Build- und Deploy-Logs: `/opt/nbc/logs/`
