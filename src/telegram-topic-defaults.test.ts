import { describe, expect, it } from 'vitest';

import { getChannelDefaults } from './channels/channel-registry.js';
import './channels/index.js';

describe('telegram-topic-support: wiring defaults', () => {
  it('preserves forum topics by default for new Telegram group wirings', () => {
    expect(getChannelDefaults('telegram').group.threads).toBe(true);
  });

  it('continues to collapse Telegram DMs to one session', () => {
    expect(getChannelDefaults('telegram').dm.threads).toBe(false);
  });
});
