# Imagem oficial do Bun — runtime, gerenciador de pacotes e executor de
# testes exigidos pelo desafio (seção 4).
FROM oven/bun:1.1-alpine

WORKDIR /app

COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

COPY . .

EXPOSE 3000

CMD ["bun", "run", "start"]
