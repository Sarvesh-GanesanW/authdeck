/** Type the computer's address when it isn't found on the network (and always on the web). */
import { useState } from 'react';
import { View } from 'react-native';

import { haptics } from '../../lib/haptics';
import { outsideNetworkMessage } from '../../net/addresses';
import { fetchHello, isAllowedHost, parseAddress } from '../../net/discovery';
import { defaultPort } from '../../net/testOverrides';
import { Field, PrimaryButton } from '../../ui/controls';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import type { PairTarget } from './pairing';

/** Long enough for a slow Wi-Fi hop, short enough that a typo fails quickly. */
const CHECK_TIMEOUT_MS = 4000;

export function AddressSheet({
  visible,
  onClose,
  onFound,
}: {
  visible: boolean;
  onClose: () => void;
  onFound: (target: PairTarget) => void;
}) {
  const [text, setText] = useState('');
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const check = async () => {
    const address = parseAddress(text);
    if (!address) {
      haptics.error();
      setProblem('Type an address like 192.168.1.24, or 192.168.1.24:47474 if the agent uses another port.');
      return;
    }
    if (!isAllowedHost(address.host)) {
      haptics.error();
      setProblem(outsideNetworkMessage(address.host));
      return;
    }
    setChecking(true);
    setProblem(null);
    const hello = await fetchHello(address.host, address.port, CHECK_TIMEOUT_MS);
    setChecking(false);
    if (!hello) {
      haptics.error();
      setProblem(
        `Nothing answered at ${address.host}:${address.port}. Check that the agent is running there and that ` +
          'the address and port match what it printed. On Windows, allow Node.js through the firewall on private networks.',
      );
      return;
    }
    haptics.success();
    onFound({
      name: hello.name,
      platform: hello.platform,
      hosts: [address.host],
      port: hello.port ?? address.port,
      agentId: hello.agentId,
      startedFrom: 'address',
    });
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Enter the address"
      subtitle="The agent prints its addresses when it starts."
      maxWidth={560}
      footer={<PrimaryButton label={checking ? 'Checking' : 'Find computer'} busy={checking} icon="search" onPress={() => void check()} />}
    >
      <View style={{ gap: 12 }}>
        <Field
          label="Address"
          value={text}
          onChangeText={(t) => {
            setText(t);
            setProblem(null);
          }}
          placeholder={`192.168.1.24:${defaultPort()}`}
          autoCapitalize="none"
          keyboardType="url"
          returnKeyType="go"
          autoFocus
          onSubmitEditing={() => void check()}
        />
        {problem ? (
          <Text tone="danger" accessibilityLiveRegion="polite">
            {problem}
          </Text>
        ) : (
          <Text tone="dim">{`Leave out the port if it is ${defaultPort()}, the agent's default.`}</Text>
        )}
      </View>
    </Sheet>
  );
}
