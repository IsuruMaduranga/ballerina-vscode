/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useEffect } from "react";

// Mirrors the Escape-to-stop handling in AIChatInput, which is unmounted while these footers show.
// Listening on window means this sees Escape wherever focus is, so anything the user opened on top —
// the chat sessions dropdown, a popup — gets first refusal by calling preventDefault on the way up.
// Without that, one Escape both dismissed the thing on top and aborted the run.
export function useEscapeToStop(onStop: () => void) {
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented) {
                return;
            }
            event.preventDefault();
            onStop();
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onStop]);
}
