import { _delete, get, patch, post, put } from './Adapter/Adapter';

describe('Axios API Adapter', () => {
  it('should export all http verbs', () => {
    expect(get).toBeDefined();
    expect(post).toBeDefined();
    expect(put).toBeDefined();
    expect(patch).toBeDefined();
    expect(_delete).toBeDefined();
  });
});
