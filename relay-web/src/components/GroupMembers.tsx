"use client";

import { useCallback, useState } from "react";
import { Modal, confirmDialog } from "@/components/Modal";
import { Icon, IconButton } from "@/components/icons";
import { InfoTip } from "@/components/InfoTip";
import { ScrollList } from "@/components/ScrollList";
import { btn, btnDanger, btnPrimary } from "@/components/ui";
import { canRemove, groupCreator } from "@/lib/groups";

/**
 * A group's members: add people, remove someone (only the group's creator can), or leave (groups.ts has the rules).
 * `onChange` sends the group_members message.
 */
export function GroupMembers({
  conv,
  me,
  people,
  nameFor,
  stillHere,
  onChange,
  onLeave,
  onClose,
}: {
  conv: { memberKeyHashes: string[]; groupId?: string };
  me: string;
  /** Everyone on the server but me, who could be added. */
  people: string[];
  nameFor: (k: string) => string;
  stillHere: (k: string) => boolean;
  onChange: (change: { add?: string[]; remove?: string[] }) => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const g = { creator: conv.groupId ? groupCreator(conv.groupId) : null, members: conv.memberKeyHashes };
  const members = conv.memberKeyHashes.filter(stillHere).sort((x, y) => (x === me ? -1 : y === me ? 1 : 0));
  const candidates = people.filter((k) => !conv.memberKeyHashes.includes(k)).sort((a, b) => nameFor(a).localeCompare(nameFor(b), undefined, { numeric: true }));
  const back = useCallback(() => {
    setAdding(false);
    setPicked(new Set());
  }, []);

  const remove = async (k: string) => {
    if (await confirmDialog(`Remove ${nameFor(k)} from the group?`, { ok: "Remove", danger: true })) onChange({ remove: [k] });
  };
  const leave = async () => {
    if (await confirmDialog("Leave the group? You won't get its messages any more.", { ok: "Leave", danger: true })) onLeave();
  };

  if (adding) {
    return (
      <Modal title="Add people" onClose={back} closeLabel={null} compact>
        {candidates.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Everyone is already in the group.</p>
        ) : (
          <form
            id="add-people"
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (picked.size === 0) return;
              onChange({ add: [...picked] });
              back();
            }}
          >
            <p className="text-xs text-[var(--muted)] flex items-center gap-1">
              They see messages from when they join.
              <InfoTip>Earlier messages were encrypted to the members at the time, so new members can&apos;t read them.</InfoTip>
            </p>
            <ScrollList>
              {candidates.map((k) => (
                <li key={k}>
                  <label className="flex items-center gap-3 cursor-pointer pl-3 pr-2 py-1.5 touch:py-2.5">
                    <input
                      type="checkbox"
                      className="w-4 h-4"
                      checked={picked.has(k)}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(k);
                          else next.delete(k);
                          return next;
                        })
                      }
                    />
                    <span className="text-sm truncate">{nameFor(k)}</span>
                  </label>
                </li>
              ))}
            </ScrollList>
          </form>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={back} className={btn}>
            Cancel
          </button>
          <button type="submit" form="add-people" disabled={picked.size === 0} className={btnPrimary}>
            Add
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Members" onClose={onClose} compact>
      <ul className="flex flex-col gap-1">
        {members.map((k) => (
          <li key={k} className="flex items-center gap-2 min-h-8 text-sm">
            <span className="truncate">{k === me ? "You" : nameFor(k)}</span>
            {k === g.creator && <span className="shrink-0 text-xs text-[var(--muted)]">owner</span>}
            {k !== me && canRemove(g, me, k) && (
              <span className="ml-auto">
                <IconButton icon="removePerson" label={`Remove ${nameFor(k)}`} danger onClick={() => remove(k)} />
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="flex justify-between gap-2">
        <button type="button" onClick={() => setAdding(true)} className={btn}>
          <Icon name="chatNewGroup" />
          Add people
        </button>
        <button type="button" onClick={leave} className={btnDanger}>
          Leave group
        </button>
      </div>
    </Modal>
  );
}
