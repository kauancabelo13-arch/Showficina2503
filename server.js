// ============================================================
//  AutoPeças IA — Servidor Principal
//  WhatsApp + Claude AI + Pagamento
// ============================================================

const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ── Configurações (preencha no .env) ─────────────────────────
const {
  WHATSAPP_TOKEN,       // Token da Meta API
  VERIFY_TOKEN,         // Token de verificação do webhook (você escolhe)
  ANTHROPIC_API_KEY,    // Chave da API do Claude
  PHONE_NUMBER_ID,      // ID do número no Meta
  PAGAMENTO_BASE_URL,   // URL base dos seus links de pagamento (ex: mercadopago)
  PORT = 3000,
} = process.env;

// ── Validação de variáveis de ambiente ───────────────────────
const VARS_OBRIGATORIAS = {
  WHATSAPP_TOKEN,
  VERIFY_TOKEN,
  ANTHROPIC_API_KEY,
  PHONE_NUMBER_ID,
};

Object.entries(VARS_OBRIGATORIAS).forEach(([nome, valor]) => {
  if (!valor) {
    console.warn(`⚠️  AVISO: Variável de ambiente "${nome}" não está definida. O bot pode não funcionar corretamente.`);
  }
});

// ── Memória de sessão (por telefone) ─────────────────────────
// Guarda histórico de conversa e carrinho de cada usuário
const sessoes = {};

function getSessao(telefone) {
  if (!sessoes[telefone]) {
    sessoes[telefone] = {
      historico: [],
      carrinho: null,
      aguardandoPagamento: false,
    };
  }
  return sessoes[telefone];
}

// ── Sistema de prompt da IA ───────────────────────────────────
const SYSTEM_PROMPT = `Você é o assistente virtual da AutoPeças IA, uma loja de autopeças online no Brasil que opera por dropshipping.

Seu trabalho é:
1. Identificar exatamente qual peça o cliente precisa (modelo do carro, ano, motorização, versão)
2. Confirmar a peça com nome técnico e código de referência quando possível
3. Informar o preço e prazo de entrega
4. Gerar um pedido estruturado quando o cliente confirmar a compra

CATÁLOGO DE PEÇAS (exemplo — substitua pelos seus fornecedores reais):
- Pastilha de freio dianteira Honda Civic 2012-2016: R$89,90 | Marca: Frasle | Cod: PD1234
- Filtro de óleo Toyota Corolla 2015-2020: R$34,90 | Marca: Mahle | Cod: FO4321
- Correia dentada VW Gol 1.0 2010-2016: R$129,90 | Marca: Gates | Cod: CT876
- Amortecedor dianteiro Fiat Uno 2011-2015: R$189,90 | Marca: Cofap | Cod: AM5678
- Filtro de ar Ford Ka 2015-2020: R$29,90 | Marca: Fram | Cod: FA999

REGRAS IMPORTANTES:
- Sempre pergunte o modelo, ano e versão do carro se não informados
- Confirme a peça antes de gerar o pedido
- Quando o cliente disser "quero comprar", "confirmar" ou "fechar pedido", responda EXATAMENTE neste formato JSON (nada mais):
{"acao":"pedido","peca":"[nome da peca]","codigo":"[codigo]","preco":[valor_numerico],"telefone":"[numero]"}
- Para dúvidas técnicas, seja preciso e use linguagem simples
- Informe sempre: prazo de entrega padrão é 3-5 dias úteis
- Frete grátis acima de R$150, abaixo disso R$19,90
- Responda sempre em português brasileiro, de forma simpática e profissional`;

// ── Função: Chamar o Claude ───────────────────────────────────
async function chamarClaude(telefone, mensagemUsuario) {
  const sessao = getSessao(telefone);

  sessao.historico.push({
    role: "user",
    content: mensagemUsuario,
  });

  // Limita histórico a 20 mensagens para economizar tokens
  if (sessao.historico.length > 20) {
    sessao.historico = sessao.historico.slice(-20);
  }

  try {
    console.log(`🤖 [Claude] Enviando ${sessao.historico.length} mensagem(ns) para o telefone ${telefone}`);

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: sessao.historico,
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      }
    );

    const resposta = response.data.content[0].text;
    console.log(`🤖 [Claude] Resposta recebida para ${telefone}: ${resposta.substring(0, 100)}${resposta.length > 100 ? "..." : ""}`);

    sessao.historico.push({
      role: "assistant",
      content: resposta,
    });

    return resposta;
  } catch (erro) {
    const status = erro.response?.status;
    const detalhe = erro.response?.data ? JSON.stringify(erro.response.data) : erro.message;
    console.error(`❌ [Claude] Erro ao chamar a API (status ${status}): ${detalhe}`);
    console.error(`❌ [Claude] Stack trace: ${erro.stack}`);
    throw erro;
  }
}

// ── Função: Enviar mensagem WhatsApp ─────────────────────────
async function enviarMensagem(telefone, texto) {
  try {
    console.log(`📤 [WhatsApp] Enviando mensagem para ${telefone}: ${texto.substring(0, 80)}${texto.length > 80 ? "..." : ""}`);

    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: telefone,
        type: "text",
        text: { body: texto },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`✅ [WhatsApp] Mensagem enviada com sucesso para ${telefone}`);
  } catch (erro) {
    const status = erro.response?.status;
    const detalhe = erro.response?.data ? JSON.stringify(erro.response.data) : erro.message;
    console.error(`❌ [WhatsApp] Erro ao enviar mensagem para ${telefone} (status ${status}): ${detalhe}`);
    console.error(`❌ [WhatsApp] Stack trace: ${erro.stack}`);
    throw erro;
  }
}

// ── Função: Gerar link de pagamento ──────────────────────────
function gerarLinkPagamento(pedido) {
  // Adapte para seu gateway (Mercado Pago, PagSeguro, etc.)
  // Aqui usamos um exemplo com Mercado Pago Checkout Pro
  const params = new URLSearchParams({
    title: pedido.peca,
    price: pedido.preco,
    quantity: 1,
    external_reference: `${pedido.telefone}-${Date.now()}`,
  });
  return `${PAGAMENTO_BASE_URL}?${params.toString()}`;
}

// ── Função: Processar mensagem recebida ──────────────────────
async function processarMensagem(telefone, texto) {
  try {
    console.log(`⚙️  [Processamento] Iniciando para ${telefone}`);
    const resposta = await chamarClaude(telefone, texto);
    const sessao = getSessao(telefone);

    // Verifica se a IA gerou um pedido estruturado
    const jsonMatch = resposta.match(/\{[^}]*"acao"\s*:\s*"pedido"[^}]*\}/);
    if (jsonMatch) {
      console.log(`🛒 [Processamento] Pedido detectado para ${telefone}: ${jsonMatch[0]}`);
      const pedido = JSON.parse(jsonMatch[0]);
      pedido.telefone = telefone;

      sessao.carrinho = pedido;
      sessao.aguardandoPagamento = true;

      const frete = pedido.preco >= 150 ? 0 : 19.9;
      const total = (pedido.preco + frete).toFixed(2);
      const linkPagamento = gerarLinkPagamento(pedido);

      const mensagemPedido =
        `✅ *Pedido confirmado!*\n\n` +
        `🔧 *Peça:* ${pedido.peca}\n` +
        `💰 *Valor:* R${pedido.preco.toFixed(2)}\n` +
        `🚚 *Frete:* ${frete === 0 ? "Grátis" : "R$" + frete.toFixed(2)}\n` +
        `💳 *Total: R${total}*\n\n` +
        `📦 Prazo: 3–5 dias úteis\n\n` +
        `👇 *Clique para pagar:*\n${linkPagamento}\n\n` +
        `_Após o pagamento, enviaremos o código de rastreio por aqui._`;

      await enviarMensagem(telefone, mensagemPedido);
      console.log(`✅ [Processamento] Pedido enviado para ${telefone}`);
      return;
    }

    // Resposta normal da IA
    await enviarMensagem(telefone, resposta);
    console.log(`✅ [Processamento] Resposta enviada para ${telefone}`);
  } catch (erro) {
    console.error(`❌ [Processamento] Erro para ${telefone}: ${erro.message}`);
    console.error(`❌ [Processamento] Stack trace: ${erro.stack}`);
    try {
      await enviarMensagem(
        telefone,
        "⚠️ Ops, tive um problema técnico. Pode repetir sua mensagem?"
      );
    } catch (erroEnvio) {
      console.error(`❌ [Processamento] Falha ao enviar mensagem de erro para ${telefone}: ${erroEnvio.message}`);
    }
  }
}

// ── Rotas ─────────────────────────────────────────────────────

// Verificação do webhook (exigida pela Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado com sucesso");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recebimento de mensagens do WhatsApp
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responde imediatamente para a Meta não reenviar

  try {
    console.log("📨 [Webhook] POST recebido");
    console.log("📨 [Webhook] Body completo:", JSON.stringify(req.body, null, 2));

    const entry = req.body?.entry?.[0];
    if (!entry) {
      console.log("📨 [Webhook] Nenhum 'entry' encontrado no body — possível evento de status ou ping da Meta");
      return;
    }

    const changes = entry?.changes?.[0];
    if (!changes) {
      console.log("📨 [Webhook] Nenhum 'changes' encontrado no entry");
      return;
    }

    console.log("📨 [Webhook] Campo 'field':", changes.field);

    const value = changes?.value;
    const mensagens = value?.messages;

    if (!mensagens || mensagens.length === 0) {
      console.log("📨 [Webhook] Nenhuma mensagem no payload — pode ser notificação de status de entrega");
      console.log("📨 [Webhook] Statuses recebidos:", JSON.stringify(value?.statuses ?? [], null, 2));
      return;
    }

    console.log(`📨 [Webhook] ${mensagens.length} mensagem(ns) recebida(s)`);

    const msg = mensagens[0];
    const telefone = msg.from;
    const tipo = msg.type;

    console.log(`📩 [Webhook] Mensagem de ${telefone} | tipo: ${tipo} | id: ${msg.id}`);

    // Só processa mensagens de texto por enquanto
    if (tipo !== "text") {
      console.log(`📨 [Webhook] Tipo "${tipo}" não suportado — enviando aviso para ${telefone}`);
      await enviarMensagem(
        telefone,
        "Por enquanto só processo mensagens de texto. Como posso te ajudar?"
      );
      return;
    }

    const texto = msg.text.body;
    console.log(`📩 [${telefone}]: ${texto}`);

    await processarMensagem(telefone, texto);
  } catch (erro) {
    console.error("❌ [Webhook] Erro inesperado:", erro.message);
    console.error("❌ [Webhook] Stack trace:", erro.stack);
  }
});

// Endpoint de teste — confirma que o servidor e o webhook estão acessíveis
app.get("/test", (req, res) => {
  const varsStatus = Object.fromEntries(
    Object.entries(VARS_OBRIGATORIAS).map(([nome, valor]) => [nome, valor ? "✅ definida" : "❌ ausente"])
  );
  res.json({
    status: "ok",
    mensagem: "Servidor AutoPeças IA está funcionando corretamente",
    timestamp: new Date().toISOString(),
    variaveis: varsStatus,
  });
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "online",
    servico: "AutoPeças IA",
    versao: "1.0.0",
  });
});

// ── Iniciar servidor ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 AutoPeças IA rodando na porta ${PORT}`);
  console.log(`📡 Webhook: http://localhost:${PORT}/webhook`);
  console.log(`🔍 Teste:   http://localhost:${PORT}/test`);
});
