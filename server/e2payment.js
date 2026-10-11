const BASE_URL = 'https://mpesaemolatech.com';

let tokenCache = null;

function getCredentials() {
  return {
    clientId: (process.env.E2PAYMENT_CLIENT_ID || '').trim(),
    clientSecret: (process.env.E2PAYMENT_SECRET || '').trim(),
    mpesaWalletId: (process.env.E2PAYMENT_MPESA_WALLET_ID || '159318').trim(),
    emolaWalletId: (process.env.E2PAYMENT_EMOLA_WALLET_ID || '511376').trim()
  };
}

async function obterTokenAcesso() {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60000) {
    return tokenCache.token;
  }

  const { clientId, clientSecret } = getCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('Credenciais da e2payments (E2PAYMENT_CLIENT_ID / E2PAYMENT_SECRET) não configuradas.');
  }

  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.message || 'Falha ao autenticar na e2payments.');
  }

  const expiresInSeconds = data.expires_in || 3600;
  tokenCache = {
    token: data.access_token,
    expiresAt: now + expiresInSeconds * 1000
  };

  return data.access_token;
}

function gerarReferencia(plano) {
  const prefixo = (plano || 'VTURB').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  const data = new Date();
  const timestamp = data.getFullYear().toString().slice(2) +
    String(data.getMonth() + 1).padStart(2, '0') +
    String(data.getDate()).padStart(2, '0') +
    String(data.getHours()).padStart(2, '0') +
    String(data.getMinutes()).padStart(2, '0');
  const random = Math.floor(100 + Math.random() * 900);
  return `${prefixo}${timestamp}${random}`;
}

async function processarPagamento({ amount, reference, phone, provider, planId }) {
  const creds = getCredentials();
  const walletId = provider === 'emola' ? creds.emolaWalletId : creds.mpesaWalletId;

  if (!walletId) {
    throw new Error(`ID de carteira para ${provider.toUpperCase()} não configurado.`);
  }

  let phoneClean = String(phone || '').replace(/\D/g, '');
  if (phoneClean.startsWith('258') && phoneClean.length === 11) {
    phoneClean = phoneClean.slice(3);
  }

  if (phoneClean.length !== 9) {
    return {
      success: false,
      status: 'failed',
      message: 'O número de telefone deve conter exatamente 9 dígitos (ex: 841234567 ou 861234567).'
    };
  }

  if (!creds.clientId || !creds.clientSecret) {
    return {
      success: true,
      status: 'simulated',
      reference: reference || gerarReferencia(planId),
      message: 'Modo de demonstração: credenciais e2payments pendentes no .env. Simulação aceita com sucesso.'
    };
  }

  const referenceClean = (reference || gerarReferencia(planId)).replace(/\s+/g, '');
  const token = await obterTokenAcesso();
  const routePath = provider === 'emola' ? 'emola-payment' : 'mpesa-payment';
  const endpoint = `${BASE_URL}/v1/c2b/${routePath}/${walletId}`;

  const payload = {
    client_id: creds.clientId,
    amount: Math.round(Number(amount)).toString(),
    phone: phoneClean,
    reference: referenceClean
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));

  if (res.ok || data.status === 'success' || data.success === true) {
    return {
      success: true,
      status: 'paid',
      reference: referenceClean,
      transactionId: data.transaction_id || data.id || referenceClean,
      message: 'Solicitação de pagamento enviada com sucesso. Por favor, introduza o seu PIN no telemóvel.'
    };
  }

  let errorMsg = data.message || data.error || 'A transação falhou na e2payments.';
  if (data.errors && typeof data.errors === 'object') {
    const firstKey = Object.keys(data.errors)[0];
    if (firstKey && Array.isArray(data.errors[firstKey]) && data.errors[firstKey][0]) {
      errorMsg = data.errors[firstKey][0];
    }
  }

  return {
    success: false,
    status: 'failed',
    message: errorMsg
  };
}

module.exports = {
  getCredentials,
  gerarReferencia,
  processarPagamento
};
