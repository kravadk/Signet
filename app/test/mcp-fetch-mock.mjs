const json = (id, result) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => ({ jsonrpc: '2.0', id, result }),
  text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }),
});

globalThis.fetch = async (_url, init = {}) => {
  const body = init.body ? JSON.parse(String(init.body)) : {};
  const id = body.id ?? 1;
  const method = body.method || '';
  if (method === 'suix_getBalance') {
    return json(id, { coinType: '0x2::sui::SUI', totalBalance: '123000000', coinObjectCount: 1 });
  }
  if (method === 'sui_getObject') {
    return json(id, {
      data: {
        objectId: body.params?.[0] ?? '0x2',
        version: '1',
        digest: 'MOCK_OBJECT_DIGEST',
        content: { dataType: 'moveObject', type: '0x2::object::UID', fields: {} },
      },
    });
  }
  if (method === 'suix_queryEvents') {
    return json(id, { data: [], hasNextPage: false, nextCursor: null });
  }
  if (method === 'sui_getTransactionBlock') {
    return json(id, { digest: body.params?.[0] ?? 'MOCK_TX', effects: { status: { status: 'success' } }, events: [], objectChanges: [] });
  }
  return json(id, {});
};
