Připrav kompletní podklady pro cestu: *$ARGUMENTS*
(Argument = destinace a/nebo datum, např. "Praha 22.4." nebo "Cannes 24.4.")

*DŮLEŽITÉ — Email aliasy:*
• `karel@obluk.com` a `karel@pinehill.cz` jsou ALIASY téhož Gmail účtu
• Při KAŽDÉM hledání zahrnout obě domény

*1. Kalendář — určení rozsahu cesty*

```bash
# Najdi události v daném období (oba kalendáře)
sqlite3 /workspace/local-db/cone.db "
SELECT summary, start_dt, end_dt, location, description, attendees, all_day
FROM events
WHERE calendar_id IN ('karel@obluk.com','karel.obluk@evolutionequity.com')
AND start_dt >= '[datum_od]' AND start_dt <= '[datum_do + 3 dny]'
ORDER BY start_dt;"
```

Hledej indikátory vícedenní cesty:
• Celodenní události typu ubytování (hotel, Airbnb) — end = den check-outu
• Transport/Cesta zpět události v následujících dnech
• Další schůzky v destinaci

*2. Kontakty na místě*

Pro každého účastníka schůzek zjisti profil z DB (entity, fakta, poslední komunikace, otevřené závazky).

```bash
# Kontakty v destinaci (z faktů)
sqlite3 /workspace/local-db/cone.db "
SELECT e.name, f.value FROM entities e
JOIN facts f ON e.id = f.entity_id
WHERE f.key = 'adresa' AND f.value LIKE '%[destinace]%' AND e.type = 'person';"
```

*3. Doprava*

Primární zdroj = kalendář. "Brno Transport" = objednaná služba přes Janu, dopravce: Transport Servis Brno.

```bash
# Hledej v emailech potvrzení dopravy
sqlite3 /workspace/local-db/cone.db "
SELECT subject, from_addr, sent_at, body FROM emails
WHERE (from_addr LIKE '%transportservis%' OR subject LIKE '%jízdenk%' OR subject LIKE '%RegioJet%' OR subject LIKE '%Flight%')
AND sent_at >= '[datum_od - 14 dní]'
ORDER BY sent_at DESC LIMIT 5;"
```

*4. Ubytování*

Primární = celodenní kalendářová událost s názvem hotelu. Sekundárně hledej v emailech.

*5. Úkoly pro cestu*
```bash
sqlite3 /workspace/local-db/cone.db "
SELECT id, description, trip_date FROM trip_tasks
WHERE location LIKE '%[destinace]%' AND status = 'open';"
```

*Výstupní formát (Telegram):*

*Příprava: [destinace] — [datum od]–[datum do]*

_Den 1 — [den týdne] [datum]_
• [čas] — [událost] — [místo] — [účastníci]
• ...

_Den 2 — [den týdne] [datum]_
• ...

_Klíčové kontakty_
*[Jméno 1]*
• Pozice, firma
• Poslední komunikace: ...
• Otevřené body: ...

_Logistika_
• Doprava tam: [status + detaily]
• Ubytování: [status + detaily]
• Doprava zpět: [status + detaily]

_Úkoly na místě_
• [ ] [úkol 1]
• [ ] [úkol 2]

_Příprava na schůzky_
• [ ] [co připravit]

Pokud chybí informace (doprava, ubytování), jasně označ jako ⚠️ NEZAJIŠTĚNO.
