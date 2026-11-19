/** Live list of AuthDeck agents on this device's network, with a rescan. */
import * as Network from 'expo-network';
import { useCallback, useEffect, useState } from 'react';

import { type Found, canScanNetwork, localSubnetLabel, scanNetwork } from '../../net/discovery';

type ScanStatus = 'unsupported' | 'scanning' | 'done' | 'failed';

export interface NetworkScan {
  status: ScanStatus;
  /**
   * One entry per address that answered, in the order they answered. Two addresses may claim the
   * same computer (its id is public), so none is dropped: the handshake decides which is real.
   */
  found: Found[];
  /** e.g. "192.168.1.x", once known. */
  subnet: string | null;
  /** Why the last scan failed, written for the user. */
  problem: string | null;
  rescan: () => void;
}

const NO_NETWORK =
  'This device is not on a Wi-Fi network. Join the same network as your computer, then scan again.';

export function useNetworkScan(): NetworkScan {
  const [status, setStatus] = useState<ScanStatus>(canScanNetwork ? 'scanning' : 'unsupported');
  const [found, setFound] = useState<Found[]>([]);
  const [subnet, setSubnet] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!canScanNetwork) return;
    // Shared with a search for a moved computer, if one is under way (net/discovery.ts).
    const scan = new AbortController();
    const signal = scan.signal;
    setStatus('scanning');
    setProblem(null);
    setFound([]);
    Network.getIpAddressAsync()
      .then((ip) => {
        if (!signal.aborted) setSubnet(localSubnetLabel(ip));
      })
      .catch(() => undefined);
    scanNetwork((f) => {
      setFound((list) => (list.some((x) => x.host === f.host) ? list : [...list, f]));
    }, signal)
      .then(() => {
        if (!signal.aborted) setStatus('done');
      })
      .catch((e: unknown) => {
        if (signal.aborted) return;
        setStatus('failed');
        setProblem(e instanceof Error && e.message === 'no-network' ? NO_NETWORK : 'Could not scan this network. Enter the address instead.');
      });
    return () => scan.abort();
  }, [round]);

  const rescan = useCallback(() => setRound((r) => r + 1), []);

  return { status, found, subnet, problem, rescan };
}
