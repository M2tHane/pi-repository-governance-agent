import React, { useEffect, useRef } from "react";

export function Modal({children,titleId,onClose,drawer=false}:{children:React.ReactNode;titleId:string;onClose:()=>void;drawer?:boolean}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current!,opener=document.activeElement as HTMLElement,overflow=document.body.style.overflow;dialog.showModal();document.body.style.overflow="hidden";return()=>{dialog.close();document.body.style.overflow=overflow;const target=opener!==document.body&&opener?.isConnected&&opener.getClientRects().length?opener:document.querySelector<HTMLElement>('dialog[open] .more-menu summary')??document.getElementById("rules-title");target?.focus();};},[]);
  return <dialog ref={ref} className={drawer?"dialog drawer":"dialog confirm-dialog"} aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target!==event.currentTarget)return;const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)onClose();}}>{children}</dialog>;
}
