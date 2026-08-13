#!/usr/bin/env python3
"""
Servidor local de apoio aos testes do Conversor Financeiro.

Serve para testar o site PUBLICADO (https://santvvar-star.github.io/...) com
arquivos reais que estão só na sua máquina:

  GET  /<arquivo>   devolve um arquivo da pasta de testes (para a página
                    buscar com fetch() e injetar no input)
  POST /<nome>      grava o corpo do pedido em _teste/<nome> (para a página
                    devolver o .xlsx/.ofx gerado e você validar com openpyxl)

Responde com CORS liberado, porque a página roda em HTTPS no github.io e
precisa falar com este servidor em http://127.0.0.1. Navegador permite
localhost como exceção à regra de conteúdo misto.

Uso:
    python servidor_upload.py                 # serve a pasta atual
    python servidor_upload.py --pasta src     # serve outra pasta
    python servidor_upload.py --porta 9000

Só escuta em 127.0.0.1 — não fica acessível para a rede. Ainda assim, é uma
ferramenta de teste: suba, use e desligue (Ctrl+C). Não deixe rodando.
"""

import argparse
import http.server
import pathlib
import sys

PORTA_PADRAO = 8899
DESTINO = "_teste"  # onde os POST caem; está no .gitignore


class Manipulador(http.server.SimpleHTTPRequestHandler):
    pasta_destino = None

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def end_headers(self):
        self._cors()
        # Sem cache: durante um teste o arquivo muda a cada rodada.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        # Só o nome do arquivo: impede que "../.." escape da pasta de destino.
        nome = pathlib.PurePosixPath(self.path.lstrip("/")).name
        if not nome:
            self.send_error(400, "informe um nome de arquivo no caminho")
            return

        try:
            tamanho = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self.send_error(400, "Content-Length inválido")
            return
        if tamanho <= 0:
            self.send_error(400, "corpo vazio")
            return

        dados = self.rfile.read(tamanho)
        destino = self.pasta_destino / nome
        destino.parent.mkdir(parents=True, exist_ok=True)
        destino.write_bytes(dados)

        print(f"  recebido: {destino}  ({len(dados)} bytes)", flush=True)

        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(f"ok {nome} {len(dados)}\n".encode("utf-8"))

    def log_message(self, formato, *args):
        print("  " + formato % args, flush=True)


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--porta", type=int, default=PORTA_PADRAO)
    p.add_argument("--pasta", default=".", help="pasta servida nos GET")
    args = p.parse_args()

    servida = pathlib.Path(args.pasta).resolve()
    if not servida.is_dir():
        print(f"ERRO: pasta não encontrada: {servida}", file=sys.stderr)
        return 1

    destino = pathlib.Path(__file__).resolve().parent / DESTINO
    Manipulador.pasta_destino = destino

    def fabrica(*a, **kw):
        return Manipulador(*a, directory=str(servida), **kw)

    endereco = ("127.0.0.1", args.porta)
    with http.server.ThreadingHTTPServer(endereco, fabrica) as servidor:
        print(f"Servindo {servida}")
        print(f"  GET  http://127.0.0.1:{args.porta}/<arquivo>")
        print(f"  POST http://127.0.0.1:{args.porta}/<nome>  ->  {destino}")
        print("Ctrl+C para parar.\n")
        try:
            servidor.serve_forever()
        except KeyboardInterrupt:
            print("\nParado.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
