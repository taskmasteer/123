import {AppError} from '../../../packages/contracts/src/model.js';
/** Blocks new API work, drains admitted requests, then takes a coherent snapshot. */
export class MaintenanceGate {
  private active=0;private waiting:(()=>void)[]=[];busy=false;
  async request<T>(action:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new AppError('UNAVAILABLE','Идёт резервное копирование. Повторите через несколько секунд.');
    this.active++;try{return await action();}finally{if(--this.active===0)this.waiting.splice(0).forEach(resolve=>resolve());}
  }
  async exclusive<T>(action:()=>Promise<T>):Promise<T>{
    if(this.busy)throw new AppError('CONFLICT','Операция обслуживания уже выполняется.');
    this.busy=true;
    try{if(this.active)await new Promise<void>(resolve=>this.waiting.push(resolve));return await action();}finally{this.busy=false;}
  }
}
