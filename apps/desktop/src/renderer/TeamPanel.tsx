import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { PermissionDecision, PermissionRequest } from '@prospero/core';
import type { ConversationSummary, DesktopBridge } from '../bridge';
import { ConversationStore, activeStates, statusLabel } from './conversation-store';
import { Timeline } from './Timeline';
import { statusTone } from './task-presentation';

function AgentCard({
  agent,
  bridge,
  store,
}: {
  agent: ConversationSummary;
  bridge: DesktopBridge;
  store: ConversationStore;
}) {
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(agent.id, listener),
    [store, agent.id],
  );
  const snapshot = useCallback(() => store.get(agent.id), [store, agent.id]);
  const conversation = useSyncExternalStore(subscribe, snapshot);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    bridge
      .getConversation(agent.id)
      .then((value) => {
        if (live) store.put(value);
      })
      .catch(() => {
        if (live) setError('Could not load this agent.');
      });
    return () => {
      live = false;
    };
  }, [agent.id, bridge, store]);
  async function decide(request: PermissionRequest, decision: PermissionDecision) {
    if (request.preview.plan) {
      if (decision === 'allow-session') return;
      await bridge.decideActionPlan(
        agent.id,
        request.requestId,
        request.preview.plan.digest,
        decision,
      );
    } else if (request.preview.research) {
      if (decision === 'allow-session') return;
      await bridge.decideResearch(
        agent.id,
        request.requestId,
        request.preview.research.digest,
        decision,
      );
    } else await bridge.decidePermission(agent.id, request.requestId, decision);
  }
  const state = conversation?.state ?? agent.state;
  return (
    <details className="agent-card" open={!!conversation?.pendingPermission || undefined}>
      <summary>
        <span className={`agent-orbit status-light ${statusTone(state)}`} aria-hidden="true" />
        <strong>{agent.title}</strong>
        <span role="status">{statusLabel(state)}</span>
      </summary>
      {activeStates.has(state) && (
        <button
          type="button"
          className="icon-button agent-stop"
          title={`Stop ${agent.title}`}
          aria-label={`Stop ${agent.title}`}
          onClick={() =>
            void bridge.stopTask(agent.id).catch(() => setError('Could not stop this agent.'))
          }
        >
          ■
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {conversation && (
        <Timeline
          items={conversation.timeline}
          streamingText={conversation.streamingText}
          state={state}
          pending={conversation.pendingPermission}
          onDecide={decide}
          sources={conversation.sources}
          actionPlans={conversation.actionPlans}
          researchPlans={conversation.researchPlans}
          onFileMenu={(path) =>
            void bridge
              .showContextMenu({ kind: 'file', conversationId: agent.id, path })
              .catch(() => setError('Could not open file actions.'))
          }
          onMessageMenu={(itemId) =>
            void bridge
              .showContextMenu({ kind: 'message', conversationId: agent.id, itemId })
              .catch(() => setError('Could not open message actions.'))
          }
          onOpenSource={(source) =>
            void bridge
              .openSource(agent.id, source)
              .catch(() => setError('Could not open this source.'))
          }
        />
      )}
    </details>
  );
}

export function TeamPanel({
  agents,
  bridge,
  store,
}: {
  agents: ConversationSummary[];
  bridge: DesktopBridge;
  store: ConversationStore;
}) {
  if (!agents.length) return null;
  return (
    <section className="team-panel" aria-label="Agent team">
      <details className="team-records" open>
        <summary className="team-heading">
          <span>Agent team</span>
          <span>
            {agents.filter((agent) => activeStates.has(agent.state)).length} active ·{' '}
            {agents.length} total
          </span>
        </summary>
        <div className="team-agents">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} bridge={bridge} store={store} />
          ))}
        </div>
      </details>
    </section>
  );
}
