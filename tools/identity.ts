import { object, query, router, string } from "apps";
import { getItem } from "../client.js";
import { Empty, User } from "../schemas.js";
import { client, READ, type Ctx } from "./context.js";

const getMe = query(
	{
		title: "Get Akahu user",
		description: "The Akahu user behind the connected account.",
		input: Empty,
		output: object({ id: string(), email: string().optional(), preferred_name: string().optional(), access_granted_at: string().optional() }),
		annotations: READ,
	},
	async (ctx: Ctx) => {
		const me = await getItem(client(ctx), "/me", User);
		return {
			id: me._id,
			...(me.email && { email: me.email }),
			...(me.preferred_name && { preferred_name: me.preferred_name }),
			...(me.access_granted_at && { access_granted_at: me.access_granted_at }),
		};
	},
);

export const identity = router({ me: getMe }, { title: "Identity", description: "The Akahu user behind the connection." });
