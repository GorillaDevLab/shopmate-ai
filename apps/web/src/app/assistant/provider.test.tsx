import {act,render,screen,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {AssistantWorkspaceProvider,useAssistantWorkspace} from "./provider";
import {AssistantStore} from "./store";
import {AssistantHistory} from "./history";
import {workspaceKey} from "./model";
vi.mock("next/navigation",()=>({usePathname:()=>"/chat"}));
const identity={userId:"u",merchantId:"m"};
function Probe(){const {state,current}=useAssistantWorkspace();return <><span>{state.ready?"已验证":"验证中"}</span><span>{current?.draft}</span><AssistantHistory/></>;}
describe("workspace authentication boundary",()=>{
  beforeEach(()=>{
    localStorage.clear();const store=new AssistantStore(localStorage);store.activate(identity);store.setDraft("只属于本人");store.rename(store.getSnapshot().currentId,"私密会话");store.flush();
  });
  afterEach(()=>vi.unstubAllGlobals());
  it("身份验证前不显示保存的历史或草稿",async()=>{
    let resolve:(v:Response)=>void=()=>undefined;
    vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(r=>{resolve=r;})));
    render(<AssistantWorkspaceProvider><Probe/></AssistantWorkspaceProvider>);
    expect(screen.queryByText("只属于本人")).not.toBeInTheDocument();expect(screen.queryByText("私密会话")).not.toBeInTheDocument();
    await act(async()=>resolve(new Response(JSON.stringify(identity))));
    expect(await screen.findByText("只属于本人")).toBeInTheDocument();
    act(()=>window.dispatchEvent(new Event("shopmate:logout")));
    expect(screen.queryByText("只属于本人")).not.toBeInTheDocument();expect(localStorage.getItem(workspaceKey(identity))).toBeNull();
  });
  it("其他账号不加载之前账号的内容",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({userId:"other",merchantId:"m"}))));
    render(<AssistantWorkspaceProvider><Probe/></AssistantWorkspaceProvider>);await screen.findByText("已验证");
    expect(screen.queryByText("只属于本人")).not.toBeInTheDocument();expect(screen.queryByText("私密会话")).not.toBeInTheDocument();
  });
  it("其他标签页清理历史时当前页也清空",async()=>{
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify(identity))));
    render(<AssistantWorkspaceProvider><Probe/></AssistantWorkspaceProvider>);await screen.findByText("只属于本人");
    act(()=>window.dispatchEvent(new StorageEvent("storage",{key:workspaceKey(identity),newValue:null})));
    await waitFor(()=>expect(screen.queryByText("只属于本人")).not.toBeInTheDocument());
  });
});
