import type React from "react";

type Navigation = { overview:boolean; rules:boolean; repositories:boolean; settings:boolean };

export function AppLayout({navigation,login,mainRef,onLogout,children}:{navigation:Navigation;login:string;mainRef:React.RefObject<HTMLElement|null>;onLogout:()=>void;children:React.ReactNode}) {
  return <><a className="skip-link" href="#main-content" onClick={event=>{event.preventDefault();mainRef.current?.focus();}}>跳到主要内容</a><header className="top"><a className="brand" href="#overview"><span className="brand-mark" aria-hidden="true">π</span><strong>Pi<span>Code review, remembered.</span></strong></a><nav aria-label="主导航">{[["overview","概览",navigation.overview],["rules","团队规则",navigation.rules],["repositories","仓库",navigation.repositories]].map(([id,label,active])=><a className={active?"active":""} aria-current={active?"page":undefined} href={`#${id}`} key={String(id)}>{label}</a>)}</nav><div className="account"><a href="#settings" className={navigation.settings?"active":""}>设置</a><span>{login}</span><button className="text-button" onClick={onLogout}>退出</button></div></header>
    <main ref={mainRef} id="main-content" tabIndex={-1} className="shell">{children}</main>
  </>;
}
