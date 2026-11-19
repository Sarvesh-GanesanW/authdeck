/**
 * The env sheets AuthHost mounts above every screen, vault open or locked: a computer's request
 * (EnvRequestSheet) and a join request to approve (EnvJoinApproveSheet), one of each at a time.
 */
import { useRef, useState } from 'react';

import type { EnvJoinRequestView, EnvRequestView } from '../../auth/envContract';
import { EnvJoinApproveSheet } from './EnvJoinApproveSheet';
import { EnvRequestSheet } from './EnvRequestSheet';
import { joinToShow, shownRequest, withClosed } from './hostQueue';
import { envSheets, useEnvSheets } from './sheetState';
import { useEnv } from './source';

export function EnvHostSheets() {
  const env = useEnv();
  const reviewId = useEnvSheets((s) => s.reviewJoinId);
  const [heldId, setHeldId] = useState<string | null>(null);
  const lastSeen = useRef<EnvRequestView | null>(null);
  const [closedRequests, setClosedRequests] = useState<ReadonlySet<string>>(() => new Set());
  const [closedJoins, setClosedJoins] = useState<ReadonlySet<string>>(() => new Set());

  // Hold the request on screen until its sheet closes, following the engine's newer copy of it.
  const request = shownRequest(heldId ? lastSeen.current : null, env.incoming, closedRequests);
  lastSeen.current = request;
  if (request && request.id !== heldId) setHeldId(request.id);

  const closeRequest = () => {
    if (!heldId) return;
    setClosedRequests(
      withClosed(
        closedRequests,
        heldId,
        env.incoming.map((r) => r.id),
      ),
    );
    setHeldId(null);
    lastSeen.current = null;
  };

  // A reviewed request stays on screen after it ends (declined after a word mismatch, say), so its
  // sheet can say what happened, until it is closed.
  const heldJoin = useRef<EnvJoinRequestView | null>(null);
  const join = joinToShow(env.joinRequests, reviewId, closedJoins) ?? (heldJoin.current?.id === reviewId ? heldJoin.current : null);
  heldJoin.current = join;
  const closeJoin = () => {
    if (!join) return;
    if (join.id === reviewId) envSheets.reviewJoin(null);
    setClosedJoins(
      withClosed(
        closedJoins,
        join.id,
        env.joinRequests.map((r) => r.id),
      ),
    );
  };

  return (
    <>
      {join ? <EnvJoinApproveSheet key={join.id} request={join} onClose={closeJoin} /> : null}
      {request ? <EnvRequestSheet key={request.id} request={request} onClose={closeRequest} /> : null}
    </>
  );
}
