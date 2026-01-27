from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType, MarketOrderArgs
from py_clob_client.order_builder.constants import BUY, SELL
import traceback

class TradeService:
    @staticmethod
    def get_client(pk, sig_type=0, funder=None):
        try:
            l1_client = ClobClient(host="https://clob.polymarket.com", chain_id=137, key=pk)
            creds = l1_client.create_or_derive_api_creds()
            client = ClobClient(
                host="https://clob.polymarket.com",
                chain_id=137,
                key=pk,
                creds=creds,
                signature_type=sig_type,
                funder=funder
            )
            return client
        except Exception as e:
            print(f"Error creating ClobClient: {e}")
            raise e

    @staticmethod
    def place_order(client, token_id, side, size=None, price=None, usdc_amount=None):
        try:
            sgn_side = BUY if side.upper() == "BUY" else SELL
            
            if price is None:
                if sgn_side == BUY:
                    if not usdc_amount: raise ValueError("Buy Market requires Amount (USDC)")
                    amt = float(usdc_amount)
                else:
                    if not size: raise ValueError("Sell Market requires Size (Shares)")
                    amt = float(size)
                    
                mo = MarketOrderArgs(token_id=token_id, amount=amt, side=sgn_side, order_type=OrderType.FOK)
                signed = client.create_market_order(mo)
                resp = client.post_order(signed, OrderType.FOK)
            else:
                if not size: raise ValueError("Limit Order requires Size")
                order = OrderArgs(price=float(price), size=float(size), side=sgn_side, token_id=token_id)
                signed = client.create_order(order)
                resp = client.post_order(signed, OrderType.GTC)
                
            return resp
        except Exception as e:
            traceback.print_exc()
            raise e
