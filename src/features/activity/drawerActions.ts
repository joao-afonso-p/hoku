import { focusProject as focus, openOverlay, openSession, select } from "../../app/actions";
import { mapKey } from "../../app/model";
import { getState, setState } from "../../app/store";
import type { Session } from "../../lib/types";

export { openOverlay, openSession, select };

/** From a list, entering a project keeps the list open (so you can keep browsing). */
export function focusProject(key: string, keepList = true) {
  const list = getState().list;
  focus(key);
  if (keepList && list && list !== "projects") setState({ list });
  if (!keepList) setState({ list: null });
}

/** Select a session from a list; enter its project on the map unless the project is archived. */
export function enterSession(s: Session) {
  const key = mapKey(s, getState().data.projects);
  if (key) focusProject(key, true);
  select(s.id);
}

export function setListNull() {
  setState({ list: null });
}
