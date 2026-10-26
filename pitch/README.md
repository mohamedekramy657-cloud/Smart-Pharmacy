# Hackathon pitch — Smart Pharmacy · الصيدلية الذكية

| File | What it is |
|---|---|
| `Smart_Pharmacy_Hackathon_Pitch.pptx` | 18-slide pitch deck (16:9) — native, editable charts; speaker notes on every slide |
| `Smart_Pharmacy_Hackathon_Pitch.pdf` | PDF export of the deck |
| `data/Smart_Pharmacy_Pitch_Data.xlsx` | Every figure in the deck with its source and link; prototype metrics; live demo analytics |
| `assets/screens/` | Real screenshots of the running prototype (demo data) |
| `assets/mockups/` | Browser / phone frames built around those screenshots |

## Rebuild
```bash
# 1. demo data (development only): base seed + showcase layer
cd apps/api && NODE_ENV=development node dist/src/database/seed.cli.js
NODE_ENV=development ALLOW_DEMO_SEED=true node dist/src/database/showcase.cli.js
# 2. with API (:4000) and web (:3000) running:
python pitch/tools/capture_screens.py && python pitch/tools/capture_extra.py
python pitch/tools/mockups.py && python pitch/tools/build_deck.py
```
Requires `python-pptx`, `Pillow`, `playwright` (Chromium), `openpyxl`, and Arabic + emoji fonts for screenshots.

**Honesty notes:** market figures come from the cited sources (slide 18). Screens and the slide-12 analytics use clearly labelled demo data (`[DEMO]` pharmacies, simulated searches); performance numbers are team measurements on synthetic data. The business model is proposed, to be validated in a pilot.
