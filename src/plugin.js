import { startManagedService } from './managed.js';
let instance;
export default {
  id: 'sktao-magpie-check',
  async server(_input, options = {}) {
    instance ||= startManagedService(options).catch(e => { instance = undefined; throw e; });
    await instance;
    return {};
  },
};
