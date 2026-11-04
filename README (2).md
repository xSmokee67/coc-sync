# coc-sync

Co 30 minut pobiera dane obu klanów z oficjalnego API Clash of Clans (przez proxy RoyaleAPI)
i zapisuje je w `sync.json`. Z tego pliku korzysta Panel Klanu.

- `config.json`: tagi klanu głównego i akademii
- sekret `COC_API_KEY` (Settings → Secrets and variables → Actions): klucz z developer.clashofclans.com z adresem IP `45.79.218.79`
- ręczne uruchomienie: zakładka **Actions → Synchronizacja CoC → Run workflow**
