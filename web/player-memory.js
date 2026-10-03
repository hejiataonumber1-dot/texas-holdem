// Remember only the browser's player identity. Room membership stays on the server.
class PlayerMemory {
  constructor(browser) {
    this.key='poker-player';
    for(const [field,key] of [['persistent','localStorage'],['tab','sessionStorage']]) {
      try { this[field]=browser[key]; } catch { this[field]=null; }
    }
    this.current={name:'',token:null};
    const saved=this.readStorage(this.persistent)||this.readStorage(this.tab);
    if(saved) this.current=saved;
    else {
      try { this.current=this.clean({name:this.tab?.getItem('poker-name'),token:this.tab?.getItem('poker-token')})||this.current; } catch {}
    }
    if(this.current.name||this.current.token) this.save(this.current);
  }
  clean(value) {
    if(!value||typeof value!=='object'||Array.isArray(value)) return null;
    const name=typeof value.name==='string'&&value.name.trim().length<=12?value.name.trim():'';
    const token=typeof value.token==='string'&&value.token.length>0&&value.token.length<=128?value.token:null;
    return name||token?{name,token}:null;
  }
  readStorage(storage) {
    try { return this.clean(JSON.parse(storage?.getItem(this.key)||'null')); } catch { return null; }
  }
  read() {
    this.current=this.readStorage(this.persistent)||this.readStorage(this.tab)||this.current;
    return {...this.current};
  }
  save(values) {
    this.current=this.clean({...this.read(),...values})||{name:'',token:null};
    for(const field of ['persistent','tab']) {
      try { this[field]?.setItem(this.key,JSON.stringify(this.current)); }
      catch { this[field]=null; }
    }
    // Once migrated, an old tab token must not override a more recent identity.
    if(this.persistent||this.tab) {
      try { this.tab?.removeItem('poker-token');this.tab?.removeItem('poker-name'); } catch {}
    }
    return {...this.current};
  }
}
if(typeof module!=='undefined')module.exports={PlayerMemory};
