#!/usr/bin/env python3
"""
Monta os HTML de arquivo único do Conversor Financeiro a partir de src/.

Gera dois arquivos, ambos a partir de src/dev.html:

  index.html               -> versão publicada no GitHub Pages. Os scripts são
                              embutidos, mas a logo continua como arquivo ao
                              lado (cess_emblema.png), servido junto.
  ConversorFinanceiro.html -> arquivo único de verdade: igual ao index.html,
                              mas com a logo embutida em base64. É o que se
                              manda por e-mail / abre sem mais nada em volta.

Também grava versao.txt com o carimbo da build. Esse mesmo carimbo vai para a
tag <script id="versao-app"> do HTML; a página compara os dois em tempo de
execução para avisar quando o navegador está servindo uma versão em cache —
por isso os dois PRECISAM ser gerados juntos, nunca editados à mão.

Uso:
    python montar_html_unico.py                      # build nova (carimbo = agora)
    python montar_html_unico.py --versao 20260728-184835   # reproduz uma build
    python montar_html_unico.py --conferir           # não grava; só confere

Tudo é feito em bytes, sem tradução de quebra de linha, para a saída ser
idêntica byte a byte independentemente do sistema operacional.
"""

import argparse
import base64
import datetime
import hashlib
import pathlib
import sys

RAIZ = pathlib.Path(__file__).resolve().parent
SRC = RAIZ / "src"

# Scripts embutidos como <script> comum, na ordem em que aparecem no dev.html.
# A substituição é feita pela tag exata, então a ordem aqui não importa.
SCRIPTS = [
    "fflate.umd.js",
    "pdf.min.js",
    "conversor.js",
    "leitor_pdf.js",
    "ui_cess.js",
]

# O worker do pdf.js não é executado na página: fica guardado como texto puro
# e o ui_cess.js transforma isso num Blob em tempo de execução. Por isso vai
# numa tag <script type="text/plain">, sem as quebras de linha extras que os
# scripts normais recebem.
WORKER = "pdf.worker.min.js"

TAG_WORKER_DEV = (
    b'<script type="text/plain" id="pdf-worker-src"'
    b' data-fallback-src="pdf.worker.min.js"></script>'
)
TAG_WORKER_FINAL = b'<script type="text/plain" id="pdf-worker-src">'

TAG_VERSAO_DEV = b'<script type="text/plain" id="versao-app">dev</script>'
TAG_VERSAO_MOLDE = b'<script type="text/plain" id="versao-app">%s</script>'

IMG_EXTERNA = b'src="cess_emblema.png"'
LOGO = "cess_emblema.png"


def erro(msg):
    print(f"ERRO: {msg}", file=sys.stderr)
    sys.exit(1)


def ler(caminho):
    if not caminho.exists():
        erro(f"arquivo não encontrado: {caminho}")
    return caminho.read_bytes()


def trocar_uma_vez(conteudo, alvo, novo, descricao):
    """Substitui exigindo exatamente uma ocorrência — se o dev.html mudar de
    forma inesperada, é melhor quebrar aqui do que gerar um HTML torto."""
    n = conteudo.count(alvo)
    if n != 1:
        erro(f"esperava 1 ocorrência de {descricao} no dev.html, encontrei {n}")
    return conteudo.replace(alvo, novo)


def montar(versao):
    """Devolve (bytes do index.html, bytes do ConversorFinanceiro.html)."""
    html = ler(SRC / "dev.html")

    html = trocar_uma_vez(
        html, TAG_VERSAO_DEV, TAG_VERSAO_MOLDE % versao.encode("ascii"),
        "a tag de versão",
    )

    for nome in SCRIPTS:
        html = trocar_uma_vez(
            html,
            b'<script src="%s"></script>' % nome.encode("ascii"),
            b"<script>\r\n" + ler(SRC / nome) + b"\r\n</script>",
            f'a tag <script src="{nome}">',
        )

    html = trocar_uma_vez(
        html,
        TAG_WORKER_DEV,
        TAG_WORKER_FINAL + ler(SRC / WORKER) + b"</script>",
        "a tag do worker do pdf.js",
    )

    # A logo do index.html continua sendo um arquivo ao lado. Confere que a
    # cópia da raiz é mesmo igual à de src/ — se divergirem, o site publicado
    # mostra uma logo diferente da do arquivo único, e ninguém percebe.
    logo_src = ler(SRC / LOGO)
    logo_raiz = ler(RAIZ / LOGO)
    if logo_src != logo_raiz:
        erro(f"{LOGO} da raiz difere do de src/ — copie o de src/ para a raiz")

    if html.count(IMG_EXTERNA) != 1:
        erro("esperava 1 referência à logo no dev.html")

    b64 = base64.b64encode(logo_src)
    unico = html.replace(
        IMG_EXTERNA, b'src="data:image/png;base64,' + b64 + b'"'
    )

    return html, unico


def resumo(dados):
    return hashlib.sha256(dados).hexdigest()[:12]


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--versao", help="carimbo a usar (padrão: AAAAMMDD-HHMMSS de agora)")
    p.add_argument("--conferir", action="store_true",
                   help="não grava nada; só diz se os arquivos no disco batem")
    args = p.parse_args()

    if args.conferir and not args.versao:
        # Confere contra o carimbo que já está gravado, senão a comparação
        # falharia sempre por causa do horário.
        atual = (RAIZ / "versao.txt").read_bytes().strip()
        args.versao = atual.decode("ascii")

    versao = args.versao or datetime.datetime.now().strftime("%Y%m%d-%H%M%S")

    index, unico = montar(versao)
    versao_txt = versao.encode("ascii") + b"\r\n"

    saidas = [
        (RAIZ / "index.html", index),
        (RAIZ / "ConversorFinanceiro.html", unico),
        (RAIZ / "versao.txt", versao_txt),
    ]

    if args.conferir:
        tudo_igual = True
        for caminho, novo in saidas:
            atual = caminho.read_bytes() if caminho.exists() else None
            igual = atual == novo
            tudo_igual = tudo_igual and igual
            estado = "idêntico" if igual else "DIFERENTE"
            print(f"  {caminho.name:<26} {estado:<10} "
                  f"(gerado {len(novo)} bytes, sha {resumo(novo)})")
        print()
        if tudo_igual:
            print(f"OK — os arquivos no disco batem com a build da versão {versao}.")
            return 0
        print("Divergência: rode sem --conferir para regerar.")
        return 1

    for caminho, dados in saidas:
        caminho.write_bytes(dados)
        print(f"  {caminho.name:<26} {len(dados):>9} bytes  sha {resumo(dados)}")

    print(f"\nVersão {versao} gerada.")
    print("Confira no navegador antes de commitar; depois do push, o GitHub "
          "Pages publica em menos de um minuto.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
