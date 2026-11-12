# caduflix-catalog

Robô que, todo dia, gera um índice de filmes e séries a partir do [TMDB](https://www.themoviedb.org/) para o app CADUFLIX montar o catálogo (em alta, lançamentos, por serviço de streaming, por gênero).

- Roda sozinho pelo GitHub Actions (`.github/workflows/daily.yml`), todo dia às 05:00 de Brasília.
- O resultado fica na release **catalog** (`index.json.gz`).
- A chave do TMDB fica no segredo `TMDB_KEY` do repositório. Nenhum dado de playlist passa por aqui.

Este produto usa a API do TMDB, mas não é endossado nem certificado pelo TMDB.
