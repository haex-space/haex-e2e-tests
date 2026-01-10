# Architecture Decision Records (ADRs)

## ADR-001: Sequentielle Testausführung

**Status:** Akzeptiert

**Kontext:**
Tests interagieren mit einer einzelnen haex-vault Instanz.

**Entscheidung:**
`workers: 1` in playwright.config.ts - alle Tests laufen sequentiell.

**Begründung:**
- Geteilter Vault-State zwischen Tests
- Authorization-State persistent
- Kein Test-Isolation möglich ohne Vault-Neustart

**Konsequenzen:**
- Längere Testlaufzeit
- Kein Parallelismus möglich
- Tests müssen State-Abhängigkeiten beachten

---

## ADR-002: VaultBridgeClient statt Extension für Tests

**Status:** Akzeptiert

**Kontext:**
Tests könnten entweder über die Browser-Extension oder direkt über WebSocket laufen.

**Entscheidung:**
Eigener VaultBridgeClient mit identischem Protokoll.

**Begründung:**
- Volle Kontrolle über Verschlüsselung
- Einfachere Fehlerdiagnose
- Unabhängig von Extension-Build
- Schnellere Tests

**Konsequenzen:**
- Doppelte Implementierung des Protokolls
- Extension-spezifische Bugs werden nicht getestet

---

## ADR-003: tauri-driver für Vault-Automation

**Status:** Akzeptiert

**Kontext:**
Vault muss für Authorization-Approval automatisiert werden.

**Entscheidung:**
Nutzung von tauri-driver (WebDriver-kompatibel).

**Begründung:**
- Offizielle Tauri-Lösung
- WebDriver-Standard
- Zugriff auf Tauri-Commands via `window.__TAURI__.invoke()`

**Konsequenzen:**
- Zusätzlicher Prozess (Port 4444)
- Keine echte UI-Interaktion nötig (nur Commands)

---

## ADR-004: Docker-basierte Testumgebung

**Status:** Akzeptiert

**Kontext:**
Tauri-Apps brauchen GUI-Umgebung (Xvfb, WebKit2GTK).

**Entscheidung:**
webtop-basierter Docker-Container mit vollständiger Desktop-Umgebung.

**Begründung:**
- Reproduzierbare Umgebung
- Alle Dependencies vorinstalliert
- CI/CD-kompatibel

**Konsequenzen:**
- Hoher Ressourcenbedarf (2GB+ shared memory)
- Längere Build-Zeiten
- Komplexes Debugging

---

## ADR-005: HLC Timestamps für CRDT Sync

**Status:** Akzeptiert

**Kontext:**
Multi-Device Sync benötigt konfliktfreie Zusammenführung.

**Entscheidung:**
Hybrid Logical Clocks (HLC) für Timestamps.

**Format:** `<ISO-Timestamp>:<Counter>:<NodeId>`

**Begründung:**
- Kausale Ordnung gewährleistet
- Konfliktauflösung durch Last-Write-Wins
- Node-spezifische Zähler für Eindeutigkeit

**Konsequenzen:**
- Komplexere Timestamp-Generierung
- Alle Clients müssen HLC implementieren

---

## ADR-006: AES-256-GCM mit Forward Secrecy

**Status:** Akzeptiert

**Kontext:**
Kommunikation zwischen Extension und Vault muss verschlüsselt sein.

**Entscheidung:**
- ECDH P-256 für Key Exchange
- AES-256-GCM für Payload-Verschlüsselung
- Ephemere Keypairs pro Request (Forward Secrecy)

**Begründung:**
- Starke Verschlüsselung
- Kompromittierung eines Requests kompromittiert nicht andere
- Standard-Crypto-Primitives

**Konsequenzen:**
- Höherer Rechenaufwand pro Request
- Komplexere Implementierung
