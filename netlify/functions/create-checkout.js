const { Client, Environment } = require('square/legacy');
const { requireFeature } = require('./_require-feature');
const { contact } = require('../../club.config');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const blocked = requireFeature('payments');
  if (blocked) return blocked;

  let items, returnTo;
  try {
    ({ items, returnTo } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  if (!items || !items.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'No items in cart' }) };
  }

  const client = new Client({
    bearerAuthCredentials: { accessToken: process.env.SQUARE_ACCESS_TOKEN },
    environment: Environment.Production,
  });

  // Cart items for an ongoing class (tagged with the CLASS_INFO `match` key
  // they were bought from on members.html) get a `classlink:{match}` note —
  // the same convention class-payment-links.js uses — so square-webhook.js
  // can auto-match this payment back to the buyer's existing registration
  // (by email) and convert it to the class(es) actually paid for, without
  // the family having to fill in a new registration form. Trial/private/
  // competition items carry no `match` and are left untagged.
  const lineItems = items.map(item => ({
    name: item.name,
    quantity: '1',
    basePriceMoney: {
      amount: BigInt(item.pence),
      currency: 'GBP',
    },
    ...(item.match ? { note: `classlink:${item.match}` } : {}),
  }));

  try {
    const { result } = await client.checkoutApi.createPaymentLink({
      idempotencyKey: `cgy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        // Only set when the cart contains at least one class item — flags
        // the order for square-webhook.js's multi-class auto-match/convert
        // handling. A cart of e.g. trial fees only doesn't need it.
        ...(items.some(i => i.match) ? { referenceId: 'classcart' } : {}),
        lineItems,
      },
      checkoutOptions: {
        redirectUrl: process.env.SITE_URL + (returnTo || '/index.html?paid=1#contact'),
        askForShippingAddress: false,
        merchantSupportEmail: contact.email,
        customFields: [{ title: "Child's full name" }],
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ checkoutUrl: result.paymentLink.url }),
    };
  } catch (err) {
    console.error('Square error:', JSON.stringify(err));
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to create checkout' }),
    };
  }
};
