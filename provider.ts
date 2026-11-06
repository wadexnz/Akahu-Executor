import { bearer, defineProvider, header, object, secrets, string } from "apps";
import { API, decode } from "./client.js";
import { User } from "./schemas.js";

// Akahu Personal App credentials. Executor stores them; app code only ever holds
// handles, which Executor's network swaps for the real values on requests to
// api.akahu.io, and only as these two exact headers.
export const akahu = defineProvider({
	name: "Akahu Personal App",
	hosts: ["api.akahu.io"],
	auth: {
		personalApp: secrets({
			label: "Akahu Personal App tokens",
			fields: object({ "App ID Token": string({ minLength: 1 }), "User Access Token": string({ minLength: 1 }) }),
			request: ({ "App ID Token": appToken, "User Access Token": userToken }) => [header("x-akahu-id", appToken), bearer(userToken)],
		}),
	},
	async health({ account, fetch, signal }) {
		const response = await fetch(`${API}/me`, { signal, headers: account.headers() });
		const { item } = await decode(response, object({ item: User }));
		const accountInfo = { externalId: item._id };
		if (item.email) return { accountInfo: { ...accountInfo, email: item.email } };
		return { accountInfo };
	},
});
