import {useEffect} from "react";

// iOS WebViews do not always resize dvh when the software keyboard opens.
export function useAssistantViewport() {
  useEffect(()=>{
    const viewport=window.visualViewport;
    if(!viewport)return;
    const update=()=>{
      if(viewport.scale!==1)return;
      document.documentElement.style.setProperty("--assistant-viewport-height",`${viewport.height}px`);
      document.documentElement.style.setProperty("--assistant-viewport-top",`${viewport.offsetTop}px`);
    };
    update();viewport.addEventListener("resize",update);viewport.addEventListener("scroll",update);
    return()=>{viewport.removeEventListener("resize",update);viewport.removeEventListener("scroll",update);document.documentElement.style.removeProperty("--assistant-viewport-height");document.documentElement.style.removeProperty("--assistant-viewport-top");};
  },[]);
}
