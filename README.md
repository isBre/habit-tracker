# Habit Tracker

PWA per il check-in serale delle abitudini: spunti cosa hai fatto, vedi i progressi e cosa migliorare.
HTML/CSS/JS vanilla, nessun build step. I dati restano sul telefono (IndexedDB).

## Come funziona

- **Abitudini quotidiane** (es. tedesco, niente telefono): l'obiettivo è il 100% dei giorni.
- **Abitudini settimanali** (es. palestra 3× a settimana): conta se centri il numero nella settimana (lun–dom).
- Il check-in si salva da solo a ogni spunta. Dopo mezzanotte (fino alle 5) apre ancora la giornata di ieri.
- Puoi tornare indietro di giorni con le frecce o toccando la striscia della settimana.
- **Progressi**: percentuali, streak, heatmap, giorni della settimana deboli, trend, legame con l'umore.

## Pubblicare su GitHub Pages

Settings → Pages → Deploy from a branch → `main` / `(root)`.
L'app è poi su `https://isbre.github.io/habit-tracker/`.

## Installare sull'iPhone

Apri il link in **Safari** → Condividi → **Aggiungi alla schermata Home**. Aprila sempre dall'icona.

## Provarla in locale

```bash
python3 -m http.server 8000   # http://localhost:8000
```

## File

| File | Cosa fa |
|---|---|
| `index.html` | 3 tab (Stasera, Progressi, Impostazioni) + dialog abitudine |
| `app.js` | Logica: streak giornaliere/settimanali, statistiche, consigli, render |
| `db.js` | Storage su IndexedDB (sostituibile con un backend) |
| `style.css` | Stile, dark/light automatico |
| `sw.js` | Service worker per l'offline |

Se aggiungi file, mettili in `ASSETS` in `sw.js` e aumenta `CACHE`.
