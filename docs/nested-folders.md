# Verschachtelte Unterordner im Dateibereich (file-storage)

Dieses Dokument beschreibt die Backend-Änderungen des Features "verschachtelte Ordner"
(Branch `feature/nested-folders`). Das zugehörige Frontend-Dokument liegt im `nuxt-client`-Repo
unter `docs/nested-folders.md`.

## Ausgangslage

Ein Dateiordner-Element auf einem Board (`FileFolderElement`, Board-Node-Typ `file-folder-element`)
zeigt bisher eine **flache** Liste von Dateien. Jede Datei ist ein `FileRecordEntity`-Dokument mit
`parentId`/`parentType`, das auf den Board-Node zeigt. Es gab keinerlei Verschachtelungskonzept.

## Zentrale Randbedingung: Berechtigungsprüfung bleibt an `parentId` gebunden

Jede Datei-Operation (`FilesStorageUC.checkPermission`) prüft Berechtigungen per RPC gegen
`schulcloud-server`, geschlüsselt über `(parentType, parentId)`. `schulcloud-server` löst diese
ID gegen seine eigene Board-Node-Sammlung auf. **`parentId` muss deshalb für jeden Datensatz —
egal auf welcher Verschachtelungstiefe — immer die echte Board-Node-ID des Dateiordner-Elements
bleiben.** Würde man `parentId` für die Verschachtelung zweckentfremden (z. B. auf die ID des
übergeordneten Unterordners setzen), würde die Berechtigungsprüfung für alle Dateien in
Unterordnern fehlschlagen, da `schulcloud-server` diese ID nicht kennt.

Die Lösung führt deshalb ein komplett neues, internes Feld `folderId` ein, das nur die
Verschachtelungsebene *innerhalb* des unveränderten `parentId`-Scopes beschreibt. Ein Unterordner
ist selbst nur ein weiterer `FileRecordEntity`-Datensatz mit `isFolder: true` — kein neuer
Board-Node, keine Änderung an `schulcloud-server` oder der Board-Domäne nötig.

## Datenmodell

`src/modules/files-storage/repo/file-record.entity.ts` — zwei neue optionale Felder:

```ts
@Property({ nullable: true })
isFolder?: boolean;

@Index()
@Property({ type: ObjectIdType, fieldName: 'folder', nullable: true })
folderId?: EntityId;
```

- `isFolder` markiert einen Datensatz als "virtueller Ordner" statt als hochgeladene Datei
  (kein Binärinhalt, kein Virenscan nötig — `securityCheck` wird direkt mit
  `ScanStatus.WONT_CHECK` angelegt, siehe `FileRecordFactory.buildFolder`).
- `folderId` ist die ID des unmittelbar umgebenden Ordner-Datensatzes. `undefined` bedeutet
  "Root-Ebene des Dateiordner-Elements" (heutiges Verhalten für alle Bestandsdaten).
- `parentId`/`parentType` bleiben für **jeden** Datensatz unverändert die Board-Node-Referenz.

**Migration:** Da MikroORM/MongoDB schemalos arbeitet und dieses Repo ohnehin keine
versionierten Migrationsdateien besitzt, ist für die neuen optionalen Felder keine Migration
nötig. Bestandsdaten ohne `folderId` werden korrekt als Root-Ebene behandelt
(`FileRecordScope.byFolderId` matcht explizit `null`/fehlendes Feld).

## Neue/geänderte Bausteine

| Datei | Änderung |
|---|---|
| `domain/file-record.do.ts` | `FileRecordProps` um `isFolder?`/`folderId?` erweitert; neue Methoden `isFolderRecord()`, `getFolderId()`, `setFolderId()`; `isDownloadable()` gibt für Ordner immer `false` zurück |
| `domain/factory/file-record.factory.ts` | Neue Methode `buildFolder(name, parentInfo, userId)`; `buildFromExternalInput`/`copy` reichen `folderId` durch |
| `domain/interface/parent-info.interface.ts` | `ParentInfo` um optionales `folderId?` erweitert |
| `domain/error/error-status.enum.ts` | Neuer Fehlercode `FOLDER_CANNOT_BE_MOVED_INTO_ITSELF` |
| `repo/file-record-scope.ts` | Neue Methode `byFolderId(folderId?)` |
| `repo/file-record.repo.ts` | Neue Methode `findByParentAndFolderId(parentId, folderId?, options?)` für die Ein-Ebenen-Auflistung; `findByParentId` (ohne Ebenen-Filter) bleibt für "gesamtes Element"-Operationen (Löschen/Wiederherstellen/Kopieren/Statistik des kompletten `FileFolderElement`) unverändert |
| `domain/service/files-storage.service.ts` | Neue Methoden: `getFileRecordsByFolderScope`, `createFolder`, `moveRecord`, `getFolderAndDescendants`; Namenskollisions-Prüfung bei Upload/Umbenennen jetzt ordnerebenen-bezogen statt global pro Element |
| `api/dto/file-storage.params.ts` | Neue DTOs `FolderQueryParams`, `CreateFolderParams`, `MoveFileParams`; `FileRecordParams` um optionales `folderId` erweitert |
| `api/dto/file-storage.response.ts` | `FileRecordResponse` um `isFolder?`/`folderId?` erweitert |
| `api/uc/files-storage.uc.ts` | Neue Methoden `createFolder`, `moveFile`; `getFileRecordsOfParent` nutzt jetzt ordnerebenen-scoped Listing; `deleteFile`/`deleteMultipleFiles` erweitern die zu löschende Menge rekursiv um alle Ordner-Nachkommen (`expandFoldersToDescendants`) |
| `api/controller/files-storage.controller.ts` | Neue Endpunkte `POST /file/folder/...` und `PATCH /file/move/:fileRecordId`; `list`/`upload`/`upload-from-url`/`add-document-to-parent`/`temp/upload` akzeptieren jetzt optional `?folderId=` |

## Warum Namenskollisions-Prüfung geändert wurde

Vorher wurde beim Hochladen/Umbenennen einer Datei gegen **alle** Dateien unter `parentId`
geprüft (unabhängig von der Ebene). Mit Unterordnern müssen zwei Dateien mit demselben Namen in
unterschiedlichen Ordnern erlaubt sein. Die Prüfung läuft daher jetzt gegen
`getFileRecordsByFolderScope(parentId, folderId)` — nur die direkten Geschwister auf derselben
Ebene.

## Kaskadierendes Löschen

`FilesStorageUC.expandFoldersToDescendants` läuft für jeden zu löschenden Datensatz, der ein
Ordner ist, rekursiv über `FilesStorageService.getFolderAndDescendants` und sammelt Ordner +
alle verschachtelten Dateien/Unterordner ein, bevor der bestehende `deletePreviewsAndFiles`-Pfad
(Vorschaubilder + S3-Löschung + Soft-Delete) unverändert darauf angewendet wird. Das ist bewusst
eine einfache, sequentielle Traversierung (kein Materialized-Path-Feld) — bei sehr tiefen/breiten
Bäumen bedeutet das O(Tiefe) DB-Anfragen, was für die erwarteten Ordnergrößen in einem Dateibereich
akzeptabel ist.

## Verschieben (`moveRecord` / `PATCH /file/move/:fileRecordId`)

- Verschiebt eine Datei oder einen Ordner nur **innerhalb desselben** `FileFolderElement`
  (derselbe `parentId`). Verschieben über verschiedene Dateiordner-Elemente hinweg ist bewusst
  nicht Teil dieses Features (würde erneut die parentId-gebundene Berechtigungsprüfung berühren).
- Validiert, dass das Zielverzeichnis (falls angegeben) tatsächlich ein Ordner im selben
  `parentId`-Scope ist (`assertIsFolderWithinSameParent`).
- Verhindert Zyklen beim Verschieben eines Ordners in einen seiner eigenen Nachkommen
  (`assertNoCycle`, wirft `FOLDER_CANNOT_BE_MOVED_INTO_ITSELF`).
- Prüft Namenskollisionen auf der Zielebene.

### Auf Staging gefundener Bug: Verschieben zur Wurzelebene wurde nie persistiert

`FileRecord.setFolderId(undefined)` (Verschieben zurück auf die oberste Ebene, `targetFolderId`
ist dann `undefined`) hat den Wert zwar im Domänenobjekt korrekt gelöscht, aber **MikroORM
überspringt bei `em.assign()` Felder, deren Wert `undefined` ist** ("nicht angegeben" wird nicht
von "explizit auf leer setzen" unterschieden). Die API-Antwort direkt nach dem Verschieben zeigte
dadurch fälschlich Erfolg (sie stammt aus dem In-Memory-Domänenobjekt), aber in der Datenbank
blieb die alte `folderId` bestehen — bei jedem erneuten Laden (Reload, neue Anfrage) war das
Element wieder in seinem alten Unterordner "verschwunden", nicht auf der Wurzelebene sichtbar,
während die flache Statistik (zählt unabhängig von `folderId`) es weiterhin korrekt mitzählte.

**Fix:** `setFolderId()` speichert beim Leeren jetzt explizit `null` statt `undefined` —
MikroORM behandelt `null` korrekt als "wirklich auf leer setzen" und persistiert es. `folderId`
ist entsprechend jetzt durchgängig als `EntityId | null | undefined` typisiert
(`FileRecordProps`, `FileRecordEntity`, `ParentInfo`, `FileRecordResponse`); `getFolderId()`
normalisiert beim Lesen weiterhin auf `EntityId | undefined`, damit der restliche Code
(Zyklus-Prüfung, Scope-Filter) unverändert bleibt. `FileRecordScope.byFolderId` matchte `null`
und fehlendes Feld schon vorher gleich, ist also mit alten (fehlendem Feld) und neuen (explizitem
`null`) Root-Datensätzen kompatibel.

### Zweiter, tieferliegender Bug zum selben Symptom: `ObjectIdType` erzeugt bei `null` eine zufällige ID

Auch nach dem obigen Fix blieb die Wurzelebene nach dem Verlassen und erneuten Betreten des
Dateibereichs leer (Unterordner/Dateien "verschwunden"), obwohl sie in der Datenbank korrekt mit
`folder: null` vorlagen. Ursache: `FileRecordScope.byFolderId` baut die Anfrage
`{ folderId: folderId ?? null }` — das Feld `folderId` ist aber über
`@Property({ type: ObjectIdType, ... })` typisiert, und MikroORM führt jeden Anfragewert für ein
typisiertes Feld durch dessen `convertToDatabaseValue`. Die gemeinsame `ObjectIdType`-Klasse
(`src/shared/repo/types/object-id.type.ts`) rief darin bislang **unbedingt** `new ObjectId(value)`
auf — und der MongoDB-Treiber erzeugt bei `new ObjectId(null)`/`new ObjectId(undefined)` eine
**neue, zufällige ID**, statt `null` durchzureichen. Aus der beabsichtigten Anfrage
`{ folder: null }` wurde dadurch zur Laufzeit `{ folder: <zufällige ID> }` — die auf **keinen**
Datensatz passt. Jede Auflistung der Wurzelebene lieferte dadurch grundsätzlich ein leeres
Ergebnis; sichtbar wurde das erst, sobald keine älteren, direkt aus Erstellen/Verschieben-Antworten
stammenden Daten mehr im Frontend-Store zwischengespeichert waren (z. B. nach dem Verlassen und
Neubetreten des Dateibereichs).

`folderId` ist das erste Feld in der gesamten Codebasis, das mit `ObjectIdType` typisiert ist und
jemals mit `null` abgefragt wird (alle anderen Felder wie `parentId`, `creatorId`,
`storageLocationId` werden immer mit echten IDs abgefragt) — der Bug lag daher vorher latent im
gemeinsamen Typ, unbemerkt, weil ihn nie zuvor jemand mit `null` ausgelöst hat.

**Fix:** `ObjectIdType.convertToDatabaseValue` gibt `null`/`undefined` jetzt unverändert zurück,
statt sie an `new ObjectId(...)` zu übergeben. Test ergänzt in
`object-id.type.spec.ts`.

## Bewusst nicht umgesetzt (Scope-Entscheidungen)

- **Rekursive Ordnergröße/-statistik**: `GET /file/stats/:parentType/:parentId` bleibt exakt wie
  heute (flache Root-Statistik). Es gibt keinen neuen Endpunkt für "Gesamtgröße inkl.
  Unterordner" — im Frontend wird die Größen-Spalte für Ordner-Zeilen einfach leer gelassen.
- **Rekursives Kopieren eines Ordners** (mit allen Unterordnern/Dateien): `copyFilesToParent`
  kopiert einen als Ordner markierten Datensatz nur flach (leerer Ordner am Ziel), da Kopieren
  von Ordnerinhalten nicht Teil der Anforderung war.
- **Verschieben zwischen unterschiedlichen Dateiordner-Elementen**: siehe oben.

## Bekannte lokale Einschränkung beim Testen

Dieses Repo verlangt Node 24 (`engines.node`); in der Entwicklungsumgebung war nur Node 18.19.1
verfügbar. `npx tsc --noEmit` lief damit sauber durch (keine Typfehler), `npm test` (Jest) ließ
sich wegen einer Inkompatibilität der `bson`/`mongodb`-Pakete mit Node 18 nicht ausführen. Vor
dem Merge sollten die bestehenden und ggf. neue Unit-/Integrationstests unter Node 24 in CI
laufen.

## Status

In manueller Prüfung auf Staging.
