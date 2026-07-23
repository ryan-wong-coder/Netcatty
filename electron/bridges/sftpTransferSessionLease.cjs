"use strict";

/**
 * Transfer-owned SFTP session leases (reference counting).
 *
 * File transfers borrow panel (or agent) sftpIds. Without leases, disconnecting
 * the browser panel calls closeSftp and kills in-flight / paused transfers.
 *
 * Model:
 * - acquire(sftpId, transferId) while a transfer uses that session
 * - release when the transfer finishes, fails, or is cancelled
 * - closeSftp with outstanding leases becomes a soft-close: the client stays
 *   in sftpClients until the last transfer releases
 * - when the last lease is released on a soft-closed session, the real close
 *   runs (pendingHardClose callback / flag)
 *
 * This is intentionally independent of UI panels. Browse can go away; transfers
 * keep their leased sessions until they complete.
 */

/**
 * @typedef {object} SftpTransferSessionLeaseStore
 * @property {(sftpId: string, transferId: string) => boolean} acquire
 * @property {(sftpId: string, transferId: string) => { released: boolean, shouldHardClose: boolean, remaining: number }} release
 * @property {(sftpId: string) => boolean} isHeld
 * @property {(sftpId: string) => number} getLeaseCount
 * @property {(sftpId: string) => string[]} listTransferIds
 * @property {(sftpId: string) => boolean} markSoftClosed
 * @property {(sftpId: string) => boolean} isSoftClosed
 * @property {(sftpId: string) => void} clear
 * @property {() => void} resetForTests
 */

/**
 * @returns {SftpTransferSessionLeaseStore}
 */
function createSftpTransferSessionLeaseStore() {
  /** @type {Map<string, Set<string>>} */
  const leases = new Map();
  /** @type {Set<string>} */
  const softClosed = new Set();

  function getSet(sftpId) {
    let set = leases.get(sftpId);
    if (!set) {
      set = new Set();
      leases.set(sftpId, set);
    }
    return set;
  }

  return {
    acquire(sftpId, transferId) {
      if (!sftpId || !transferId) return false;
      const set = getSet(sftpId);
      const before = set.size;
      set.add(String(transferId));
      // Keep soft-close sticky. Panel already asked to tear down this session;
      // new transfers may still borrow it, but the last release must hard-close.
      // Clearing softClosed here previously leaked sockets forever after
      // panel close + re-acquire + all transfers finishing.
      return set.size > before;
    },

    release(sftpId, transferId) {
      if (!sftpId || !transferId) {
        return { released: false, shouldHardClose: false, remaining: 0 };
      }
      const set = leases.get(sftpId);
      if (!set || !set.has(String(transferId))) {
        return {
          released: false,
          shouldHardClose: softClosed.has(sftpId) && (!set || set.size === 0),
          remaining: set ? set.size : 0,
        };
      }
      set.delete(String(transferId));
      const remaining = set.size;
      if (remaining === 0) {
        leases.delete(sftpId);
        const shouldHardClose = softClosed.has(sftpId);
        if (shouldHardClose) softClosed.delete(sftpId);
        return { released: true, shouldHardClose, remaining: 0 };
      }
      return { released: true, shouldHardClose: false, remaining };
    },

    isHeld(sftpId) {
      if (!sftpId) return false;
      const set = leases.get(sftpId);
      return !!(set && set.size > 0);
    },

    getLeaseCount(sftpId) {
      if (!sftpId) return 0;
      return leases.get(sftpId)?.size ?? 0;
    },

    listTransferIds(sftpId) {
      if (!sftpId) return [];
      return [...(leases.get(sftpId) ?? [])];
    },

    /**
     * Panel wants to close this session. If transfers still hold it, defer the
     * real teardown until the last transfer releases.
     * @returns {boolean} true when close was deferred (session stays open)
     */
    markSoftClosed(sftpId) {
      if (!sftpId) return false;
      if (!this.isHeld(sftpId)) {
        softClosed.delete(sftpId);
        return false;
      }
      softClosed.add(sftpId);
      return true;
    },

    isSoftClosed(sftpId) {
      return !!sftpId && softClosed.has(sftpId);
    },

    clear(sftpId) {
      if (!sftpId) return;
      leases.delete(sftpId);
      softClosed.delete(sftpId);
    },

    resetForTests() {
      leases.clear();
      softClosed.clear();
    },
  };
}

/** Process-wide store shared by transferBridge and closeSftp. */
const sftpTransferSessionLeaseStore = createSftpTransferSessionLeaseStore();

module.exports = {
  createSftpTransferSessionLeaseStore,
  sftpTransferSessionLeaseStore,
};
