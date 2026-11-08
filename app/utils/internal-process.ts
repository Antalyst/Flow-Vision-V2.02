import type { InternalRoute } from '~/types'

/**
 * An internal process shown with RouteFlow: the office's umbrella units in order, then back at the office,
 * which approves or returns it. Inside one office: none of these are organization route steps.
 */
export function internalProcessFlow(r: InternalRoute) {
  return [
    ...r.steps.map((st) => ({ step_number: st.step_number, office_id: st.office_id, office: st.office ? { name: st.office.name, code: st.office.code } : null, action_label: st.action_label ?? 'Scans it in, works on it, passes it on', is_final_checkpoint: false })),
    { step_number: r.steps.length + 1, office_id: r.office_id, office: r.office ? { name: r.office.name, code: r.office.code } : null, action_label: 'Back at the office: approve or return', is_final_checkpoint: true },
  ]
}

/** "Unit A → Unit B → back to Office", for a one-line summary. */
export const internalProcessChain = (r: InternalRoute) => [...r.steps.map((st) => st.office?.name ?? '—'), `back to ${r.office?.name ?? 'the office'}`].join(' → ')
