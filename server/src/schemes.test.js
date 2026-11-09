import test from 'node:test';import assert from 'node:assert/strict';import {calculateLine} from './schemes.js';
test('buy 10 get 1 free calculates free cases without discounting price',()=>{const r=calculateLine({quantity:20,price:8.1,scheme:{type:'free',threshold:10,value:1}});assert.equal(r.freeQuantity,2);assert.equal(r.total,162);});
test('3 percent slab discount applies at five cases',()=>{const r=calculateLine({quantity:5,price:101.5,scheme:{type:'discount',threshold:5,value:3}});assert.equal(r.discount,15.225);assert.equal(r.total,492.275);});
test('no slab discount below threshold',()=>{const r=calculateLine({quantity:4,price:101.5,scheme:{type:'discount',threshold:5,value:3}});assert.equal(r.discount,0);});
test('rejects invalid quantities',()=>{assert.throws(()=>calculateLine({quantity:0,price:10}),/Quantity/);assert.throws(()=>calculateLine({quantity:501,price:10}),/Quantity/);});
