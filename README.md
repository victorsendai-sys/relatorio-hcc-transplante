# Relatório de Situação Especial HCC — Rede de Transplantes

Aplicativo web **100% no navegador** que lê documentos médicos (PDF), extrai as
informações relevantes e gera o **relatório de Situação Especial HCC (carcinoma
hepatocelular)** para a Central de Transplantes (SP), no formato do formulário
oficial + carta médica.

## Por que "no navegador"?

- **Privacidade (LGPD):** nenhum documento é enviado para servidores. Toda a
  leitura (OCR), análise e geração do relatório acontece localmente, no seu
  computador. As bibliotecas (`pdf.js`, `tesseract.js`) vêm de CDN, mas os
  **PDFs nunca saem da máquina**.
- **Custo zero:** site estático, sem servidor, sem conta, sem API paga.

## Como funciona

1. **Upload** de um ou mais PDFs (exames e laudos).
2. **Conversão** de cada página em imagem (`pdf.js`).
3. **OCR** em português (`tesseract.js`) — necessário porque os exames são
   digitalizados (imagens), não texto digital.
4. **Detecção automática** do tipo de documento:
   - Tela MELD (receptor)
   - Laudo laboratorial (MELD)
   - Alfa-fetoproteína
   - Quimioembolização (TACE)
   - TC de tórax
   - RNM Abdome
   - Formulário HCC / Carta à Central
5. **Extração** dos campos (nome, RGCT, CPF, MELD-Na, labs, AFP, datas, TACE…).
6. **Formulário editável** para conferência/correção (OCR pode errar).
7. **Geração do relatório**: formulário oficial HCC + carta à Central,
   prontos para **Imprimir / Salvar em PDF**.

## Como rodar

É um site estático. Qualquer uma das opções:

```bash
# opção 1: Python
python3 -m http.server 8000
# abra http://localhost:8000

# opção 2: Node
npx serve .
```

> Abrir o `index.html` direto com `file://` pode falhar por restrições de
> CORS/worker; prefira servir via `http.server`.

## Hospedagem gratuita

Por ser estático, pode ser publicado de graça em **GitHub Pages**, **Netlify**
ou **Vercel** — basta subir os 3 arquivos (`index.html`, `styles.css`, `app.js`).

## ⚠️ Aviso

Ferramenta de **apoio**. O reconhecimento automático pode conter erros; todos os
valores devem ser **conferidos por um profissional** antes do envio à Central de
Transplantes.

## Arquivos

| Arquivo | Função |
|---|---|
| `index.html` | Interface (upload, formulário, relatório) |
| `styles.css` | Estilo + regras de impressão |
| `app.js` | OCR, detecção, extração e geração do relatório |
